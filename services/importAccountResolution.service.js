// services/importAccountResolution.service.js — resolve-or-create accounts for
// bulk imports.
//
// Runs the full deterministic chain for an imported account cell:
//   name match → code match → synonym match → auto-create (inferred shape).
// Auto-created accounts are flagged (`autoCreated: true`), audit-logged, given
// the next standard code in their type's range, and pushed into the caller's
// in-memory account list so later rows in the same batch reuse them instead of
// creating duplicates. A duplicate-key race (two concurrent imports creating
// the same account) re-resolves instead of failing the row.
//
// Junk guard: never creates from names that are too short or purely numeric —
// a typo'd cell must not become a ledger account.
'use strict';
const ChartOfAccount = require('../models/ChartOfAccount.model');
const { matchAccountByName } = require('../utils/accountMatcher');
const { matchByCode, matchBySynonym, inferAccountShape, nextAccountCode } = require('../utils/importAccountResolver');
const auditService = require('./audit.service');
const logger = require('../config/logger');

const MIN_CREATABLE_NAME = 3;

function isCreatableName(name) {
  const clean = String(name || '').trim();
  if (clean.length < MIN_CREATABLE_NAME) return false;
  if (/^[\d\s.,-]+$/.test(clean)) return false; // numeric-only cells are codes/typos, not account names
  return true;
}

/**
 * Resolve an imported account cell to a live account, creating it when needed.
 *
 * @param {string} businessId
 * @param {Array}  accounts  the business's live CoA (MUTATED: created accounts are pushed)
 * @param {string} rawName   the cell value ("Owner Equity", "3110", "Rent Expense")
 * @param {{side?:'debit'|'credit', transactionType?:string, allowCreate?:boolean,
 *          userId?:string, refreshAccounts?:Function}} ctx
 * @returns {Promise<{account:object|null, created:boolean, how:string|null, wouldCreate?:object}>}
 */
async function resolveForImport(businessId, accounts, rawName, ctx = {}) {
  const { side, transactionType, allowCreate = true, userId = null, refreshAccounts = null } = ctx;

  // 1. Name (exact → substring → word overlap)
  const byName = matchAccountByName(accounts, rawName);
  if (byName.account) return { account: byName.account, created: false, how: byName.matchType };

  // 2. Standard account code
  const byCode = matchByCode(accounts, rawName);
  if (byCode) return { account: byCode, created: false, how: 'code' };

  // 3. Bookkeeping vernacular
  const bySynonym = matchBySynonym(accounts, rawName);
  if (bySynonym) return { account: bySynonym, created: false, how: 'synonym' };

  // 4. Auto-create
  if (!isCreatableName(rawName)) return { account: null, created: false, how: null };
  const shape = inferAccountShape(rawName, { side, transactionType });
  if (!allowCreate) return { account: null, created: false, how: null, wouldCreate: shape };

  const doc = {
    businessId,
    accountName: String(rawName).trim(),
    accountType: shape.accountType,
    accountSubtype: shape.accountSubtype,
    normalBalance: shape.normalBalance,
    accountCode: nextAccountCode(accounts, shape.accountType, shape.accountSubtype),
    isDefault: false,
    autoCreated: true,
    runningBalance: 0,
  };

  try {
    const account = await ChartOfAccount.create(doc);
    accounts.push(account); // later rows in this batch resolve to it, not a duplicate
    auditService.log({
      entityType: 'account',
      entityId: String(account._id),
      action: 'create',
      performedBy: userId || 'system-import',
      businessId,
      afterState: { accountName: doc.accountName, accountCode: doc.accountCode, accountType: doc.accountType, autoCreated: true },
      metadata: { reason: 'auto-created during bulk import (account not found in Chart of Accounts)' },
    }).catch((e) => logger.warn(`[importAccountResolution] audit log failed (non-fatal): ${e.message}`));
    logger.info(`[importAccountResolution] auto-created account "${doc.accountName}" (${doc.accountCode}, ${doc.accountType}) for business ${businessId}`);
    return { account, created: true, how: 'created' };
  } catch (err) {
    // Unique-index race: someone else created it between our read and write.
    if (err.code === 11000 && refreshAccounts) {
      const fresh = await refreshAccounts();
      accounts.length = 0; accounts.push(...fresh);
      const again = matchAccountByName(accounts, rawName);
      if (again.account) return { account: again.account, created: false, how: again.matchType };
    }
    logger.warn(`[importAccountResolution] auto-create failed for "${rawName}": ${err.message}`);
    return { account: null, created: false, how: null };
  }
}

module.exports = { resolveForImport };

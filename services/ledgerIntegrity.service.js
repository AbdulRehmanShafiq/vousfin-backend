// services/ledgerIntegrity.service.js — canonical journal-lines program, Phase 0
//
// READ-ONLY drift verifier. Compares each account's cached `runningBalance`
// against the balance DERIVED from the journal (sum of that account's effective
// lines — journalLines if present, else the synthesised debit/credit pair —
// exactly how the Trial Balance reads the ledger). The guardrail run before and
// after every later phase, and a candidate for a scheduled health check.
'use strict';
const accountRepository = require('../repositories/account.repository');
const transactionRepository = require('../repositories/transaction.repository');
const { JOURNAL_STATUS } = require('../config/constants');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Balance-affecting statuses: every posting that moved a cached running balance.
// Unlike REPORT_STATUSES this INCLUDES 'reversed' — a reversed original and its
// (posted) reversal both moved the cached balance and net to zero, so the
// journal-derived balance must count both to match the cache.
const BALANCE_STATUSES = [
  JOURNAL_STATUS.POSTED, JOURNAL_STATUS.PARTIALLY_SETTLED,
  JOURNAL_STATUS.SETTLED, JOURNAL_STATUS.REVERSED,
];

/**
 * @param {string} businessId
 * @param {Date} [asOfDate=now]
 * @returns {Promise<{
 *   asOf: Date, balanced: boolean, totalDebits: number, totalCredits: number,
 *   driftedCount: number, totalAbsDrift: number,
 *   accounts: Array<{accountId, code, name, normalBalance, cached, derived, drift}>
 * }>}
 */
async function computeDrift(businessId, asOfDate = new Date()) {
  const [accounts, totals] = await Promise.all([
    accountRepository.findByBusiness(businessId),
    transactionRepository.getDebitCreditTotals(businessId, asOfDate, { statuses: BALANCE_STATUSES }),
  ]);

  const debitBy = new Map((totals.debitTotals || []).map((d) => [String(d._id), d.total]));
  const creditBy = new Map((totals.creditTotals || []).map((c) => [String(c._id), c.total]));

  let totalDebits = 0, totalCredits = 0, driftedCount = 0, totalAbsDrift = 0;
  const rows = [];

  for (const acc of accounts) {
    const id = String(acc._id);
    const debit = r2(debitBy.get(id) || 0);
    const credit = r2(creditBy.get(id) || 0);
    const derived = r2(acc.normalBalance === 'Debit' ? debit - credit : credit - debit);
    const cached = r2(acc.runningBalance || 0);
    const drift = r2(cached - derived);
    if (drift !== 0) { driftedCount++; totalAbsDrift = r2(totalAbsDrift + Math.abs(drift)); }
    rows.push({ accountId: id, code: acc.accountCode, name: acc.accountName, normalBalance: acc.normalBalance, cached, derived, drift });
  }

  // Global double-entry check uses ALL line totals, not only accounts that still exist.
  for (const v of debitBy.values()) totalDebits = r2(totalDebits + v);
  for (const v of creditBy.values()) totalCredits = r2(totalCredits + v);

  return {
    asOf: asOfDate,
    balanced: r2(totalDebits) === r2(totalCredits),
    totalDebits: r2(totalDebits),
    totalCredits: r2(totalCredits),
    driftedCount,
    totalAbsDrift,
    accounts: rows,
  };
}

module.exports = { computeDrift };

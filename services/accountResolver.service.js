// services/accountResolver.service.js
//
// ONE way to get a chart-of-accounts account. Everything that posts should use
// this and nothing else.
//
// WHY
// ---
// Account lookup had grown five competing idioms — a name regex (fiscalYear), a
// bare findOne by code (invoice/bill), $in fallback lists, resolveCostAccounts,
// ensureTaxAccounts — and most of them, on a miss, logged a warning and skipped
// the posting entirely. That scatter WAS the fail-open surface:
//
//   • Renaming "Retained Earnings" silently turned year-end close into a no-op,
//     permanently, because close matched on /retained earnings/i.
//   • A missing revenue account silently recognised no revenue — while COGS,
//     which had already been fixed to fail closed, still posted. One half of an
//     invoice disagreed with the other.
//
// THE CHAIN
// ---------
//   1. by accountCode — the authoritative key, immune to renaming
//   2. by role/subtype — for callers who want "the AR account", not "1110"
//   3. seed it from DEFAULT_ACCOUNTS — idempotent, the same definition
//      bulkCreateDefaultAccounts uses
//   4. only now, refuse — in plain language, naming what is missing
//
// Self-healing is deliberate, and it is bounded: step 3 only ever creates an
// account VousFin itself defines as a default. An unknown code is a bug, not a
// gap to paper over, so it throws. We never invent an account.
'use strict';

const mongoose = require('mongoose');
const ChartOfAccount = require('../models/ChartOfAccount.model');
const { DEFAULT_ACCOUNTS } = require('../config/constants');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');

const DEFAULT_BY_CODE = new Map(
  DEFAULT_ACCOUNTS.filter((a) => a.accountCode).map((a) => [a.accountCode, a])
);

const oid = (v) => new mongoose.Types.ObjectId(String(v));

/**
 * Resolve one account for a business, healing a missing default on the way.
 *
 * @param {string|ObjectId} businessId
 * @param {string} accountCode  e.g. '1110'
 * @param {Object} [opts]
 * @param {import('mongoose').ClientSession} [opts.session]
 * @returns {Promise<Object>} the account (lean)
 * @throws {ApiError} 400 when the code is unknown and cannot be healed
 */
async function resolve(businessId, accountCode, { session = null } = {}) {
  if (!accountCode) throw new ApiError(400, 'An account code is required to resolve an account.');
  const bizId = oid(businessId);

  const found = await ChartOfAccount.findOne({ businessId: bizId, accountCode })
    .session(session)
    .lean();
  if (found) return found;

  // Not there. Heal it if — and only if — VousFin defines it as a default.
  const template = DEFAULT_BY_CODE.get(accountCode);
  if (!template) {
    throw new ApiError(
      400,
      `This business doesn't have account ${accountCode} set up, and it isn't one `
      + 'VousFin can create automatically. Add it under Settings → Chart of Accounts, then try again.'
    );
  }

  return seedDefault(bizId, template, { session });
}

/**
 * Create a missing default account. Idempotent under concurrency: two callers
 * racing to heal the same account both end up with the same one, because the
 * upsert — not a check-then-insert — is what decides.
 * @private
 */
async function seedDefault(bizId, template, { session = null } = {}) {
  try {
    const res = await ChartOfAccount.findOneAndUpdate(
      { businessId: bizId, accountCode: template.accountCode },
      { $setOnInsert: { ...template, businessId: bizId, runningBalance: 0 } },
      { upsert: true, new: true, setDefaultsOnInsert: true, session }
    ).lean();

    logger.info(
      `[accountResolver] healed missing default ${template.accountCode} `
      + `(${template.accountName}) for business ${bizId}`
    );
    return res;
  } catch (err) {
    // Two callers healing the same account at once both reach the upsert, and
    // the loser trips a unique index ({businessId, accountName}, since the
    // upsert filters on accountCode). That is the database doing its job — the
    // winner's account is the right one, so read it back rather than failing a
    // posting over a race we do not care about.
    if (err && err.code === 11000) {
      const twin = await ChartOfAccount.findOne({
        businessId: bizId, accountCode: template.accountCode,
      }).session(session).lean();
      if (twin) return twin;
    }
    throw err;
  }
}

/**
 * Resolve several accounts at once, keyed however the caller likes.
 *
 *   const { ar, revenue } = await resolveMany(bizId, { ar: '1110', revenue: '4110' })
 *
 * Resolving up front — before any stock moves or any journal is built — is the
 * INV-5 lesson: the old order touched stock first and skipped the journal when
 * an account turned out to be missing, which is permanent GL drift.
 *
 * @param {string|ObjectId} businessId
 * @param {Object<string,string>} spec  { name: accountCode }
 * @param {Object} [opts] { session }
 * @returns {Promise<Object<string,Object>>}
 */
async function resolveMany(businessId, spec, { session = null } = {}) {
  const out = {};
  // Sequential, NOT Promise.all: a ClientSession permits only one operation in
  // flight at a time, and firing these concurrently on a shared session makes
  // mongod reject the second with "Only servers in a sharded cluster can start a
  // new transaction at the active transaction number". These are a handful of
  // indexed point lookups, so the ordering costs nothing worth having.
  for (const name of Object.keys(spec)) {
    out[name] = await resolve(businessId, spec[name], { session });
  }
  return out;
}

/** Resolve and return only the _id — for callers that just need to post. */
async function resolveId(businessId, accountCode, { session = null } = {}) {
  return (await resolve(businessId, accountCode, { session }))._id;
}

/** Every account code VousFin can heal. Useful for diagnostics and tests. */
function healableCodes() {
  return [...DEFAULT_BY_CODE.keys()];
}

module.exports = { resolve, resolveMany, resolveId, healableCodes };

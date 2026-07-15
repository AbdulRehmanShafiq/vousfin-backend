/**
 * tests/live/harness.js — the real-database test tier.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every other test in this repo mocks persistence. That means ~2,000 green
 * tests can pass while no MongoDB aggregation, index, session or hook has ever
 * actually run. Two production defects proved the cost:
 *
 *   • audit F1 — reversal entries misstated every financial statement, and was
 *     invisible to 1,786 green tests, because the income-statement pipeline was
 *     never executed.
 *   • inventory aging valued its age bands at the wrong cost and disagreed with
 *     the valuation report — invisible to 2,030 green tests, caught only by
 *     driving the live server by hand.
 *
 * Mocks cannot see that class of bug: a mocked `aggregate()` returns whatever
 * the test author imagined. So this tier runs against a REAL mongod, in
 * replica-set mode (`withTransaction` and sessions require one), executing the
 * real pipelines, indexes and middleware.
 *
 * Boot costs ~5s per file. Keep live files few and broad; put narrow logic
 * checks in the mocked unit tier where they belong.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let replSet = null;

/**
 * Register every schema. Model hooks resolve siblings lazily via
 * `mongoose.model('X')` — JournalEntry's period-lock hook reaches for
 * AccountingPeriod, for instance — which throws MissingSchemaError unless that
 * file has been required. Loading all of them mirrors the real server, where
 * routes pull in the whole graph anyway.
 */
function registerAllModels() {
  const dir = path.join(__dirname, '..', '..', 'models');
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.model.js')) require(path.join(dir, f));
  }
}

/** Boot a real mongod (replica set = transactions work) and connect mongoose. */
async function startLiveDb() {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await mongoose.connect(replSet.getUri(), { dbName: 'vousfin_live' });
  registerAllModels();
  return mongoose.connection;
}

async function stopLiveDb() {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
  replSet = null;
}

/** Wipe every collection between tests without paying for a re-boot. */
async function resetDb() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

/**
 * Build indexes declared on the schemas. Mongoose only auto-builds them lazily,
 * and some invariants ARE indexes (e.g. the unique idempotency key from F7), so
 * a test that never builds them cannot prove them.
 */
async function buildIndexes() {
  await Promise.all(Object.values(mongoose.models).map((m) => m.createIndexes()));
}

/** A business with the full default chart of accounts, as production seeds it. */
async function seedBusiness({ currency = 'PKR', name = 'Live Test Co' } = {}) {
  const User = require('../../models/User.model');
  const Business = require('../../models/Business.model');
  const accountRepository = require('../../repositories/account.repository');

  const { USER_ROLES } = require('../../config/constants');
  const user = await User.create({
    fullName: 'Live Tester',
    email: `live-${new mongoose.Types.ObjectId()}@example.com`,
    password: 'hashed-not-used-in-these-tests',
    role: USER_ROLES.CUSTOMER, // a business owner IS a 'customer' of VousFin
  });
  const business = await Business.create({
    userId: user._id,
    businessName: name,
    businessType: 'Private Limited',
    currency,
    fiscalYearStartMonth: 1,
  });
  await accountRepository.bulkCreateDefaultAccounts(business._id);

  const ChartOfAccount = require('../../models/ChartOfAccount.model');
  const accounts = await ChartOfAccount.find({ businessId: business._id }).lean();
  const byCode = new Map(accounts.map((a) => [a.accountCode, a]));

  return {
    user,
    business,
    businessId: String(business._id),
    accounts,
    /** Look an account up by its code — throws loudly rather than returning undefined. */
    acct: (code) => {
      const a = byCode.get(code);
      if (!a) throw new Error(`Live harness: no account ${code} in the seeded chart`);
      return a;
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   GOLDEN INVARIANTS

   The four statements that must be true of a correct set of books, after ANY
   operation. Deliberately delegates to the SAME services production uses
   (ledgerIntegrity, report.service) rather than re-implementing the maths —
   a re-implementation would only prove the test agrees with itself.
   ══════════════════════════════════════════════════════════════════════════ */

/** 1. Every journal balances, and the ledger as a whole balances. */
async function assertJournalsBalance(businessId) {
  const JournalEntry = require('../../models/JournalEntry.model');
  const entries = await JournalEntry.find({
    businessId: new mongoose.Types.ObjectId(String(businessId)),
  }).lean();

  const broken = [];
  let totalDr = 0;
  let totalCr = 0;
  for (const e of entries) {
    const lines = e.journalLines?.length
      ? e.journalLines
      : [
        { type: 'debit', amount: e.amount, accountId: e.debitAccountId },
        { type: 'credit', amount: e.amount, accountId: e.creditAccountId },
      ];
    const dr = lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amount, 0);
    const cr = lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amount, 0);
    if (Math.abs(dr - cr) >= 0.01) broken.push({ id: String(e._id), desc: e.description, dr, cr });
    totalDr += dr;
    totalCr += cr;
  }
  return { broken, totalDr: r2(totalDr), totalCr: r2(totalCr) };
}

/** 2. Cached running balances match what the journal actually says. */
async function driftReport(businessId) {
  const { computeDrift } = require('../../services/ledgerIntegrity.service');
  return computeDrift(businessId);
}

/** 3. Assets = Liabilities + Equity, through the real report pipeline. */
async function balanceSheetEquation(businessId, asOf = new Date()) {
  const reportService = require('../../services/report.service');
  const bs = await reportService.getBalanceSheet(businessId, asOf);
  const diff = r2((bs.totalAssets || 0) - (bs.totalLiabilitiesAndEquity || 0));
  return { diff, bs };
}

/** 4. AR/AP sub-ledgers reconcile to their control accounts. */
async function subLedgerDrift(businessId) {
  const { computeArApSubledgerDrift } = require('../../services/ledgerIntegrity.service');
  return computeArApSubledgerDrift(businessId);
}

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Assert every invariant. Call this after every operation a live test performs.
 *
 * Delegates to `booksAssurance.assertCorrect` — the PRODUCT's own standing check
 * — rather than re-implementing the maths here. That is the whole point: a test
 * that reimplements the rule only proves it agrees with itself, whereas asserting
 * the product's check means a green suite is evidence about the product.
 *
 * It then adds one check the product's version deliberately skips: that EVERY
 * individual entry balances. computeDrift proves the ledger balances in total,
 * which a pair of equal-and-opposite broken entries could still satisfy. Scanning
 * every entry is too expensive to do on a live request, but a test can afford it.
 */
async function expectGoldenInvariants(businessId, { asOf = new Date() } = {}) {
  const booksAssurance = require('../../services/booksAssurance.service');
  const result = await booksAssurance.assertCorrect(businessId, { asOf });

  const journals = await assertJournalsBalance(businessId);
  if (journals.broken.length) {
    throw new Error(
      `Unbalanced journal(s) — each entry must balance on its own:\n${JSON.stringify(journals.broken, null, 2)}`
    );
  }

  return { assurance: result, journals };
}

module.exports = {
  startLiveDb,
  stopLiveDb,
  resetDb,
  buildIndexes,
  seedBusiness,
  expectGoldenInvariants,
  assertJournalsBalance,
  driftReport,
  balanceSheetEquation,
  subLedgerDrift,
};

// services/booksAssurance.service.js
//
// THE GOLDEN INVARIANTS — the four statements that must be true of a correct set
// of books, checkable at any moment against live data.
//
//   1. Every entry balances, and so does the ledger as a whole.
//   2. Cached account balances match the entries behind them.
//   3. What you own = what you owe + what's yours.        (A = L + E)
//   4. Customer and supplier balances match the books.    (sub-ledger ↔ control)
//
// WHY THIS EXISTS
// ---------------
// VousFin's engine is architecturally right, and the rules it enforces INSIDE a
// chokepoint never fail: the poster refuses an unbalanced journal, so drift is 0
// everywhere, always. The rules left to convention are the ones that broke.
// This is the standing check that the whole thing still adds up — so the product
// can say "your books are provably correct as of 14:32" rather than hope so.
//
// It is deliberately the SAME code the live test tier asserts against
// (tests/live/harness.js expectGoldenInvariants delegates here). A test that
// re-implemented the maths would only prove it agrees with itself; making the
// product's own check the thing under test means a green suite is evidence about
// the product, not about the test.
//
// Every check DERIVES from the accounting records — computeDrift replays the
// journal, the balance sheet runs the real report pipeline. Nothing here stores
// or caches a verdict.
'use strict';

const { computeDrift, computeArApSubledgerDrift } = require('./ledgerIntegrity.service');
const reportService = require('./report.service');
const logger = require('../config/logger');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const TOLERANCE = 0.01; // one cent — below this is rounding, not a break

/**
 * A source failure must read as "couldn't verify", NEVER as "all clear".
 * Same fail-closed stance as closeReadiness: silence is not evidence.
 */
async function safeCheck(key, title, fn) {
  try {
    return await fn();
  } catch (err) {
    logger.warn(`[booksAssurance] ${key} could not be verified: ${err.message}`);
    return {
      key,
      title,
      ok: false,
      verified: false,
      detail: 'We could not check this just now. Try again in a moment.',
    };
  }
}

/**
 * Check every invariant against live data.
 *
 * @param {string|ObjectId} businessId
 * @param {Object} [opts]
 * @param {Date} [opts.asOf] — the balance sheet date to test the equation on
 * @returns {Promise<{correct:boolean, verified:boolean, verifiedAt:Date,
 *                    checks:Array, breaks:Array, summary:string}>}
 */
async function verify(businessId, { asOf = new Date() } = {}) {
  // One replay of the journal answers both "does the ledger balance" and
  // "do the cached balances match it".
  const driftPromise = computeDrift(businessId);

  const [entriesBalance, balancesMatch, equationHolds, subLedgerAgrees] = await Promise.all([
    safeCheck('entries_balance', 'Every entry balances', async () => {
      const d = await driftPromise;
      return {
        key: 'entries_balance',
        title: 'Every entry balances',
        ok: d.balanced,
        verified: true,
        // Plain language: an owner reads this, not an accountant. "Every debit
        // has a matching credit" is the same sentence in a dialect they do not
        // speak.
        detail: d.balanced
          ? 'Every amount is recorded as coming from somewhere and going somewhere.'
          : `Your records add up to ${d.totalDebits} on one side and ${d.totalCredits} on the other.`,
      };
    }),

    safeCheck('balances_match', 'Account balances match the entries', async () => {
      // Reuse the replay above rather than running a second one — this is the
      // "one replay answers both" the promise exists for, and a full journal
      // replay is the expensive part of this whole check.
      const d = await driftPromise;
      const worst = (d.accounts || [])
        .filter((a) => Math.abs(a.drift) >= TOLERANCE)
        .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));
      return {
        key: 'balances_match',
        title: 'Account balances match the entries',
        ok: worst.length === 0,
        verified: true,
        detail: worst.length === 0
          ? 'Every account shows exactly what its entries add up to.'
          : `${worst.length} account${worst.length === 1 ? '' : 's'} shows a different `
            + `balance to its entries — the largest is ${worst[0].name} (off by ${Math.abs(worst[0].drift)}).`,
        offenders: worst.slice(0, 5).map((a) => ({
          code: a.code, name: a.name, shows: a.cached, shouldBe: a.derived, off: a.drift,
        })),
      };
    }),

    safeCheck('equation_holds', 'What you own matches what you owe', async () => {
      const bs = await reportService.getBalanceSheet(businessId, asOf);
      const diff = r2((bs.totalAssets || 0) - (bs.totalLiabilitiesAndEquity || 0));
      return {
        key: 'equation_holds',
        title: 'What you own matches what you owe',
        ok: Math.abs(diff) < TOLERANCE,
        verified: true,
        detail: Math.abs(diff) < TOLERANCE
          ? 'Your balance sheet balances.'
          : `Your balance sheet is out by ${Math.abs(diff)}.`,
      };
    }),

    safeCheck('subledger_agrees', 'Customer and supplier balances match the books', async () => {
      const s = await computeArApSubledgerDrift(businessId);
      const notes = [];
      if (!s.ar.reconciled) notes.push(`customers are out by ${Math.abs(s.ar.subledgerDrift)}`);
      if (!s.ap.reconciled) notes.push(`suppliers are out by ${Math.abs(s.ap.subledgerDrift)}`);
      return {
        key: 'subledger_agrees',
        title: 'Customer and supplier balances match the books',
        ok: s.reconciled,
        verified: true,
        detail: s.reconciled
          ? 'What each customer and supplier owes adds up to what the books say.'
          : `What the books say and what the list says disagree: ${notes.join(' and ')}.`,
      };
    }),
  ]);

  const checks = [entriesBalance, balancesMatch, equationHolds, subLedgerAgrees];
  const breaks = checks.filter((c) => !c.ok);
  const verified = checks.every((c) => c.verified);
  const correct = verified && breaks.length === 0;

  return {
    correct,
    verified,
    verifiedAt: new Date(),
    checks,
    breaks,
    summary: correct
      ? 'Your books add up.'
      : verified
        ? `${breaks.length} thing${breaks.length === 1 ? '' : 's'} to look at.`
        : 'We could not fully check your books just now.',
  };
}

/**
 * Throw unless every invariant holds. For callers that want a gate rather than a
 * report — the live test tier, and any job that must not proceed on broken books.
 */
async function assertCorrect(businessId, { asOf = new Date() } = {}) {
  const res = await verify(businessId, { asOf });
  if (!res.correct) {
    const detail = res.checks
      .filter((c) => !c.ok)
      .map((c) => `  ✗ ${c.title}: ${c.detail}`)
      .join('\n');
    throw new Error(`Books do not add up:\n${detail}`);
  }
  return res;
}

module.exports = { verify, assertCorrect };

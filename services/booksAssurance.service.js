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

const mongoose = require('mongoose');
const { computeDrift, computeArApSubledgerDrift } = require('./ledgerIntegrity.service');
const reportService = require('./report.service');
const logger = require('../config/logger');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const TOLERANCE = 0.01; // one cent — below this is rounding, not a break

/**
 * Documents that say a sale or purchase happened, which the ledger never heard of.
 *
 * WHY THIS IS A SEPARATE INVARIANT
 * --------------------------------
 * The other four ask "is the ledger self-consistent?" — and they were ALL GREEN
 * while two approved invoices worth 88,500 sat outside the books entirely
 * (submitForApproval auto-promoted below-threshold documents and returned before
 * posting). Nothing caught it, because an absent entry breaks no balance: the
 * trial balance still balanced, drift was still 0, A still equalled L + E. A
 * missing document is not an inconsistency, it is an ABSENCE — invisible to
 * every check that only reads the ledger.
 *
 * So this one reads the other way: from the authoritative DOCUMENTS back to the
 * ledger, and asks whether each one arrived. A document in a recognised state
 * with no journal behind it is revenue or a liability the books are silently
 * missing.
 *
 * Drafts and cancelled/voided documents are excluded — they are not claims that
 * anything happened.
 */
async function unpostedDocuments(businessId) {
  const Invoice = require('../models/Invoice.model');
  const Bill = require('../models/Bill.model');
  const bizId = new mongoose.Types.ObjectId(String(businessId));

  const [invoices, bills] = await Promise.all([
    Invoice.find({
      businessId: bizId,
      isArchived: { $ne: true },
      state: { $in: ['approved', 'sent', 'partially_paid', 'paid', 'overdue'] },
      arJournalId: null,
      linkedJournalEntryId: null,
    }).select('invoiceNumber state totalAmount issueDate').lean(),
    Bill.find({
      businessId: bizId,
      isArchived: { $ne: true },
      state: { $in: ['approved', 'partially_paid', 'paid', 'overdue'] },
      apLiabilityJournalId: null,
      linkedJournalEntryId: null,
    }).select('billNumber state totalAmount issueDate').lean(),
  ]);

  return [
    ...invoices.map((i) => ({
      kind: 'invoice', id: i._id, number: i.invoiceNumber,
      state: i.state, totalAmount: i.totalAmount, date: i.issueDate,
    })),
    ...bills.map((b) => ({
      kind: 'bill', id: b._id, number: b.billNumber,
      state: b.state, totalAmount: b.totalAmount, date: b.issueDate,
    })),
  ];
}

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

  const [entriesBalance, balancesMatch, equationHolds, subLedgerAgrees, everythingRecorded] = await Promise.all([
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
      // The reconcile reads the open-items UNION (journal-authority entries +
      // document-authority invoice-first items). The linkage sweep guards the
      // discriminator itself: a projection that lost its document (or a
      // document that lost its journal) would silently mis-sum forever, so it
      // surfaces here the day it happens.
      const openItemService = require('./openItem.service');
      const [s, linkage] = await Promise.all([
        computeArApSubledgerDrift(businessId),
        openItemService.projectionLinkageBreaks(businessId),
      ]);
      const notes = [];
      if (!s.ar.reconciled) notes.push(`customers are out by ${Math.abs(s.ar.subledgerDrift)}`);
      if (!s.ap.reconciled) notes.push(`suppliers are out by ${Math.abs(s.ap.subledgerDrift)}`);
      if (linkage.length) {
        notes.push(`${linkage.length} document${linkage.length === 1 ? ' has' : 's have'} a broken link to the books`);
      }
      const ok = s.reconciled && linkage.length === 0;
      return {
        key: 'subledger_agrees',
        title: 'Customer and supplier balances match the books',
        ok,
        verified: true,
        detail: ok
          ? 'What each customer and supplier owes adds up to what the books say.'
          : `What the books say and what the list says disagree: ${notes.join(' and ')}.`,
        offenders: linkage.slice(0, 5),
      };
    }),

    safeCheck('everything_recorded', 'Everything you sold and bought is recorded', async () => {
      const missing = await unpostedDocuments(businessId);
      const total = r2(missing.reduce((s, d) => s + (d.totalAmount || 0), 0));
      const inv = missing.filter((d) => d.kind === 'invoice').length;
      const bil = missing.filter((d) => d.kind === 'bill').length;
      const parts = [];
      if (inv) parts.push(`${inv} invoice${inv === 1 ? '' : 's'}`);
      if (bil) parts.push(`${bil} bill${bil === 1 ? '' : 's'}`);
      return {
        key: 'everything_recorded',
        title: 'Everything you sold and bought is recorded',
        ok: missing.length === 0,
        verified: true,
        detail: missing.length === 0
          ? 'Every invoice and bill you have approved is in the books.'
          // toLocaleString so it reads as money (88,500) rather than a bare
          // 88500 — this line is read by an owner, not a developer.
          : `${parts.join(' and ')} worth ${total.toLocaleString()} ${missing.length === 1 ? 'is' : 'are'} `
            + 'approved but missing from your books. Open each one and approve it again to record it.',
        offenders: missing.slice(0, 10),
      };
    }),
  ]);

  const checks = [entriesBalance, balancesMatch, equationHolds, subLedgerAgrees, everythingRecorded];
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

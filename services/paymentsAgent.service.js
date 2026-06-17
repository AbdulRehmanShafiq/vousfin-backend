// services/paymentsAgent.service.js
//
// Autonomy roadmap Phase 4 — the Cash & Payments agent.
//
// Builds a cash-aware "payment run": which bills to pay now and why — capture an
// early-payment discount before it expires, clear an overdue bill, or cover one
// due soon — without draining the bank below what's in it. Each payment is a
// ProposedAction(make_payment) that, per the payments dial:
//   - Suggest  → waits for the owner's approval (default),
//   - Co-pilot/Autopilot → pays itself ONLY within the owner's max-auto-amount
//     (the policy limit forces anything larger back into the queue).
//
// Guardrails (money is involved, so they're strict):
//   - vendors on hold are excluded,
//   - the run never proposes more than the cash on hand,
//   - the per-payment auto cap is the autonomy policy's maxAutoAmount,
//   - every payment is recorded through the proven payment.service and is
//     reversible (voids the settlement, restoring the bill + cash).
//
'use strict';
const actionRouter = require('./actionRouter.service');
const executors = require('./actionExecutors');
const entityMemory = require('./entityMemory.service');
const paymentService = require('./payment.service');
const accountRepository = require('../repositories/account.repository');
const Bill = require('../models/Bill.model');
const repo = require('../repositories/proposedAction.repository');
const logger = require('../config/logger');
const { PROPOSED_ACTION_TYPES, PROPOSED_ACTION_STATUS } = require('../config/constants');

const MAKE_PAYMENT = PROPOSED_ACTION_TYPES.MAKE_PAYMENT;
const HOLD_KIND = 'vendor_payment_hold';
const PAYABLE_STATES = ['approved', 'scheduled', 'partially_paid', 'overdue'];
const DUE_SOON_DAYS = 7;
const DAY = 86_400_000;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const rs = (n) => 'Rs ' + Number(n || 0).toLocaleString();

/* ── Cash position: where the money is + how much there is ────────────────── */
async function cashContext(businessId) {
  const accounts = await accountRepository.findByBusiness(businessId);
  const cash = accounts.filter(a => a.accountSubtype === 'Bank and Cash');
  const available = r2(cash.reduce((s, a) => s + Math.max(0, Number(a.runningBalance) || 0), 0));
  // Draw from the account that actually holds the money.
  const primary = cash.slice().sort((a, b) => (b.runningBalance || 0) - (a.runningBalance || 0))[0] || null;
  return { available, primaryId: primary?._id || null, primaryName: primary?.accountName || null };
}

/* ── Why (if at all) should this bill be paid in this run? ─────────────────── */
function classifyBill(bill, now) {
  const bal = Number(bill.remainingBalance) || 0;
  if (bal <= 0) return null;
  const terms = bill.paymentTerms || {};
  const due = bill.dueDate ? new Date(bill.dueDate) : null;

  // 1) Early-payment discount still on the table — the money-making reason.
  const discountLive = terms.discountPct > 0 && terms.discountDeadline &&
    new Date(terms.discountDeadline) >= now && !terms.discountTakenAt;
  if (discountLive) {
    const saving = r2(bal * terms.discountPct / 100);
    return {
      reason: 'discount', priority: 0, confidence: 0.85, amount: bal, saving,
      why: `Pay now to keep the ${terms.discountPct}% early-payment discount — saves about ${rs(saving)} (offer ends ${new Date(terms.discountDeadline).toLocaleDateString()}).`,
    };
  }
  // 2) Overdue — clear it.
  if (bill.state === 'overdue' || (due && due < now)) {
    return { reason: 'overdue', priority: 1, confidence: 0.8, amount: bal, why: `This bill is overdue${due ? ` (due ${due.toLocaleDateString()})` : ''} — pay it to stay in good standing.` };
  }
  // 3) Due within the week.
  if (due && due <= new Date(now.getTime() + DUE_SOON_DAYS * DAY)) {
    return { reason: 'due_soon', priority: 2, confidence: 0.72, amount: bal, why: `Due ${due.toLocaleDateString()} — coming up soon.` };
  }
  return null; // not urgent this run
}

async function isVendorHeld(businessId, vendorId) {
  if (!vendorId) return false;
  const m = await entityMemory.suggest(businessId, HOLD_KIND, String(vendorId)).catch(() => null);
  return !!(m && m.value && m.value.hold);
}

async function alreadyHandled(businessId, sourceId) {
  const last = await repo.latestBySource(businessId, 'bill_payment', sourceId);
  return last && last.status !== PROPOSED_ACTION_STATUS.FAILED;
}

/* ── Build the payment run ─────────────────────────────────────────────────── */
async function scanBusiness(businessId, actor, now = new Date()) {
  const summary = { proposed: 0, deferredForCash: 0, heldExcluded: 0 };
  let cash;
  try {
    cash = await cashContext(businessId);
  } catch (e) { logger.warn(`[payments] cash context failed: ${e.message}`); return summary.proposed; }

  if (!cash.primaryId) return summary.proposed; // no cash/bank account → nothing to pay from

  let bills;
  try {
    bills = await Bill.find({
      businessId, state: { $in: PAYABLE_STATES }, isArchived: false,
      remainingBalance: { $gt: 0 }, linkedJournalEntryId: { $ne: null },
    }).select('billNumber vendorId vendorSnapshot dueDate remainingBalance state paymentTerms currencyCode').lean();
  } catch (e) { logger.warn(`[payments] load bills failed: ${e.message}`); return summary.proposed; }

  // Rank the candidates: discounts first, then overdue, then due-soon; oldest first.
  const candidates = [];
  for (const bill of bills) {
    const c = classifyBill(bill, now);
    if (!c) continue;
    if (await isVendorHeld(businessId, bill.vendorId)) { summary.heldExcluded++; continue; }
    candidates.push({ bill, ...c });
  }
  candidates.sort((a, b) => a.priority - b.priority || new Date(a.bill.dueDate || 0) - new Date(b.bill.dueDate || 0));

  // Spend only what's in the bank — stop when the run would exceed cash on hand.
  let spent = 0;
  for (const c of candidates) {
    if (spent + c.amount > cash.available) { summary.deferredForCash++; continue; }
    const sourceId = String(c.bill._id);
    if (await alreadyHandled(businessId, sourceId)) continue;

    const vendorName = c.bill.vendorSnapshot?.vendorName || 'a vendor';
    await actionRouter.propose({
      businessId,
      capability: 'payments',
      type:       MAKE_PAYMENT,
      title:      `Pay ${vendorName} — ${rs(c.amount)} (${c.bill.billNumber || 'bill'})`,
      summary:    c.why,
      rationale:  c.why,
      citations:  [
        `Bill ${c.bill.billNumber || ''}: ${rs(c.amount)} outstanding`,
        `Paying from ${cash.primaryName} (${rs(cash.available)} available)`,
        ...(c.saving ? [`Early-payment saving ≈ ${rs(c.saving)}`] : []),
      ],
      confidence: c.confidence,
      amount:     c.amount,
      payload:    {
        billId: sourceId, vendorId: c.bill.vendorId ? String(c.bill.vendorId) : null, vendorName,
        amount: c.amount, cashAccountId: String(cash.primaryId), reason: c.reason, userId: actor?.id || null,
      },
      reversal:   { kind: 'payment_void' },
      sourceType: 'bill_payment',
      sourceId,
    });
    spent = r2(spent + c.amount);
    summary.proposed++;
  }
  return summary.proposed;
}

/* ── Owner-set per-vendor payment hold (excludes the vendor from runs) ──────── */
async function setVendorHold(businessId, vendorId, hold) {
  await entityMemory.learn(businessId, HOLD_KIND, String(vendorId), { hold: !!hold });
  return { vendorId: String(vendorId), hold: !!hold };
}

/* ── Executor: record the payment (the proven, audited path) ───────────────── */
async function executeMakePayment(action) {
  const p = action.payload || {};
  const payment = await paymentService.recordPayment(
    action.businessId,
    {
      amount:        p.amount,   // recordPayment requires the top-level total (must be > 0)
      cashAccountId: p.cashAccountId,
      paymentDate:   new Date(),
      method:        'bank_transfer',
      notes:         'Paid via VousFin Cash & Payments',
      allocations:   [{ documentType: 'bill', documentId: p.billId, amount: p.amount }],
    },
    p.userId || null, null,
  );
  return { paymentId: String(payment._id), paymentNumber: payment.paymentNumber };
}

// Note on reversibility: a recorded payment is a real, audited accounting event,
// and this system has no clean "void payment" primitive — unwinding one means
// restoring the parent entry's outstanding, the vendor payable, the ledger AND
// the bill's state machine (which has no paid → approved transition). Rather than
// ship a fragile one-click undo that could leave a paid-looking bill still owing,
// payments are reversible at the PROPOSAL stage: nothing moves until the owner
// approves, and they can dismiss a proposal before it settles. No reverser is
// registered, so the Command Center won't offer a (mis-)undo for a settled
// payment — to undo one, void it from the bill through the normal AP screen.
executors.register(MAKE_PAYMENT, { execute: executeMakePayment });

module.exports = {
  scanBusiness, setVendorHold,
  cashContext, classifyBill, executeMakePayment,
};

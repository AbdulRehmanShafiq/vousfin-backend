// services/earlyPaymentDiscount.service.js
//
// AR/AP Refactor — Milestone M8 (early-payment discounts).
//
// Realizes the "X/Y net Z" early-payment discount carried in a document's
// paymentTerms snapshot, when the document is settled within the discount
// window. The discount reduces the outstanding balance via a GL-correct,
// non-cash posting:
//
//   • Customer (invoice): DR Sales Returns & Allowances 4115 / CR AR 1110
//       — economically identical to a sales allowance, so it REUSES the
//         already-tested M5 credit-memo path (no duplicate accounting logic).
//   • Vendor (bill):      DR AP 2110 / CR Discount Received 4180
//       — a distinct posting because a discount TAKEN is income, not an
//         expense reversal; not covered by the vendor credit-memo path.
//
// Guards (idempotent, accounting-safe):
//   • terms must define a discount (discountPct > 0)
//   • settlement date must fall within the discount window
//   • document must be open with remaining balance > 0
//   • discount can be taken at most once (paymentTerms.discountTakenAt guard)
//
'use strict';
const ChartOfAccount = require('../models/ChartOfAccount.model');
const { postBalancedJournal } = require('./ledgerPosting.service');
const partyBalanceService = require('./partyBalance.service');
const arApVoidCredit = require('./arApVoidCredit.service');
const auditService = require('./audit.service');
const paymentTermsUtil = require('../utils/paymentTerms');
const { businessEvents, EVENTS } = require('./businessEventEngine.service');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const {
  TRANSACTION_TYPES, TRANSACTION_SOURCES, JOURNAL_STATUS,
  INVOICE_STATES, BILL_STATES, ENTITY_TYPES, AUDIT_ACTIONS,
} = require('../config/constants');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

class EarlyPaymentDiscountService {
  /** Read-only preview of the discount available on a document as of `asOf`. */
  preview(kind, doc, asOf = new Date()) {
    const remaining = r2(doc.remainingBalance != null ? doc.remainingBalance : doc.totalAmount);
    const terms = doc.paymentTerms && doc.paymentTerms.code ? doc.paymentTerms : null;
    if (!terms) {
      return { available: false, reason: 'no_terms', discountAmount: 0, outstanding: remaining };
    }
    const p = paymentTermsUtil.settlementPreview(remaining, doc.issueDate, terms, asOf);
    const alreadyTaken = !!doc.paymentTerms.discountTakenAt;
    return {
      available: p.discountAvailable && p.discountAmount > 0 && !alreadyTaken && remaining > 0,
      reason: alreadyTaken ? 'already_taken' : (p.discountAvailable ? 'available' : 'window_passed'),
      terms: p.terms,
      discountDeadline: p.discountDeadline,
      discountAmount: p.discountAmount,
      netDueIfDiscounted: p.netDueIfDiscounted,
      outstanding: remaining,
    };
  }

  /**
   * Apply the early-payment discount to a hydrated Invoice/Bill document.
   * @param {'invoice'|'bill'} kind
   * @param {object} doc      — hydrated mongoose doc
   * @param {object} user
   * @param {string} ipAddress
   * @param {{ asOf?: Date }} opts
   */
  async apply(kind, doc, user, ipAddress, { asOf = new Date() } = {}) {
    const isInvoice = kind === 'invoice';
    const STATES = isInvoice ? INVOICE_STATES : BILL_STATES;

    if (!doc.paymentTerms || !doc.paymentTerms.code) {
      throw new ApiError(400, `This ${kind} has no payment terms with an early-payment discount`);
    }
    if (doc.paymentTerms.discountTakenAt) {
      throw new ApiError(409, 'Early-payment discount has already been taken on this document');
    }
    if ([STATES.VOIDED, STATES.CANCELLED, STATES.PAID].includes(doc.state)) {
      throw new ApiError(409, `Cannot apply an early-payment discount to a ${doc.state} ${kind}`);
    }

    const remaining = r2(doc.remainingBalance != null ? doc.remainingBalance : doc.totalAmount);
    if (!(remaining > 0)) throw new ApiError(400, 'No outstanding balance to discount');

    if (!paymentTermsUtil.isDiscountAvailable(doc.issueDate, doc.paymentTerms, asOf)) {
      throw new ApiError(400, 'The early-payment discount window has passed');
    }
    const discount = paymentTermsUtil.computeDiscount(remaining, doc.issueDate, doc.paymentTerms, asOf);
    if (!(discount > 0)) throw new ApiError(400, 'No early-payment discount is available for this document');

    const label = doc.paymentTerms.label || doc.paymentTerms.code;
    const reason = `Early-payment discount (${label})`;

    if (isInvoice) {
      // Reuse the GL-correct credit-memo path: DR 4115 / CR AR, reduces remaining,
      // unwinds AR balance, records the allowance. Single accounting source.
      await arApVoidCredit.applyCreditMemo('invoice', doc, discount, reason, user, ipAddress);
    } else {
      await this._postVendorDiscount(doc, discount, reason, user);
    }

    // Stamp the terms snapshot so the discount cannot be taken twice.
    doc.paymentTerms.discountTakenAt = new Date();
    doc.paymentTerms.discountTakenAmount = discount;
    doc.lastModifiedBy = user._id;
    await doc.save();

    try {
      await auditService.log({
        businessId: doc.businessId,
        entityType: isInvoice ? ENTITY_TYPES.INVOICE : ENTITY_TYPES.BILL,
        entityId: doc._id, action: AUDIT_ACTIONS.DISCOUNT_APPLIED,
        performedBy: user._id, performedByName: user.fullName || user.email || 'User',
        afterState: { discount, terms: label, remainingBalance: doc.remainingBalance },
        ipAddress,
      });
    } catch (e) {
      // best-effort: audit-log write is observability only; the discount was already applied and saved.
      logger.warn(`[earlyPaymentDiscount] audit failed: ${e.message}`);
    }

    businessEvents.emit(EVENTS.EARLY_PAYMENT_DISCOUNT_APPLIED, {
      businessId: String(doc.businessId), userId: user._id,
      entityType: isInvoice ? ENTITY_TYPES.INVOICE : ENTITY_TYPES.BILL, entityId: doc._id,
      number: doc.invoiceNumber || doc.billNumber, amount: discount, kind: isInvoice ? 'customer' : 'vendor',
    });
    return doc;
  }

  /** Vendor early-pay discount taken: DR AP / CR Discount Received (income). @private */
  async _postVendorDiscount(bill, discount, reason, user) {
    const businessId = bill.businessId;
    const ap = await ChartOfAccount.findOne({ businessId, accountCode: '2110' }).lean();
    const discountIncome = await ChartOfAccount.findOne({ businessId, accountCode: '4180' }).lean();
    if (!ap || !discountIncome) throw new ApiError(400, 'Required accounts (AP 2110 / Discount Received 4180) not found');

    const numberRef = bill.billNumber;
    const je = await postBalancedJournal({
      businessId, transactionDate: new Date(),
      description: `${reason} — ${numberRef}`,
      transactionType: TRANSACTION_TYPES.CREDIT_PURCHASE,
      amount: r2(discount),
      debitAccountId:  ap._id,             // DR AP (reduce what we owe)
      creditAccountId: discountIncome._id, // CR Discount Received (income)
      status: JOURNAL_STATUS.POSTED, transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
      invoiceNumber: numberRef, currencyCode: bill.currencyCode || 'PKR', exchangeRate: bill.exchangeRate || 1,
      createdBy: user._id, lastModifiedBy: user._id, vendorId: bill.vendorId,
    });

    const remaining = r2(bill.remainingBalance != null ? bill.remainingBalance : bill.totalAmount);
    const newRemaining = Math.max(0, r2(remaining - discount));
    bill.creditMemos = (bill.creditMemos || []).concat([{
      amount: r2(discount), reason, journalEntryId: je._id, appliedAt: new Date(), createdBy: user._id,
    }]);
    bill.paidAmount = Math.min(r2((bill.paidAmount || 0) + discount), r2(bill.totalAmount));
    bill.remainingBalance = newRemaining;
    const target = newRemaining <= 0.009 ? BILL_STATES.PAID : BILL_STATES.PARTIALLY_PAID;
    if (target !== bill.state && bill.constructor.canTransition(bill.state, target)) {
      if (typeof bill.recordStateChange === 'function') bill.recordStateChange(target, user, reason);
      bill.state = target;
    }

    await partyBalanceService.adjustPayable(businessId, bill.vendorId, -discount, {
      userId: user._id, reason: 'early_payment_discount', entityType: ENTITY_TYPES.BILL, entityId: bill._id,
    });
    return je;
  }
}

module.exports = new EarlyPaymentDiscountService();

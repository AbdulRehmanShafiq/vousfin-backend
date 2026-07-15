/**
 * arApVoidCredit.service.js — AR/AP Domain Refactor, Milestone M5.
 *
 * Accounting-correct VOID and CREDIT MEMO for invoices (AR) and bills (AP).
 *
 * RULES (enterprise accounting):
 *   • Voiding NEVER deletes records. It posts REVERSING journal entries (via
 *     ledgerPosting, balanced + running-balance synced), unwinds the party
 *     balance, marks state = voided, and preserves the original recognition /
 *     settlement entries untouched → historical reporting stays intact.
 *   • The JournalEntry remains the immutable ledger; void/credit add NEW entries.
 *   • Idempotent-ish: a voided document cannot be voided again.
 *
 * GL (invoice; bill is the mirror):
 *   Void:   DR Revenue(net) / CR AR        + DR Output-Tax / CR AR
 *           + (if paid) DR AR / CR Cash     (refund)            → nets the doc to 0
 *   Credit: DR Sales Returns 4115 / CR AR   (non-cash settlement, reduces AR)
 */

'use strict';

const ChartOfAccount = require('../models/ChartOfAccount.model');
const JournalEntry = require('../models/JournalEntry.model');
const { postBalancedJournal } = require('./ledgerPosting.service');
const partyBalanceService = require('./partyBalance.service');
const auditService = require('./audit.service');
const { businessEvents, EVENTS } = require('./businessEventEngine.service');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const {
  TRANSACTION_TYPES, TRANSACTION_SOURCES, JOURNAL_STATUS,
  INVOICE_STATES, BILL_STATES, ENTITY_TYPES, AUDIT_ACTIONS,
} = require('../config/constants');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

class ArApVoidCreditService {
  /** Resolve a Chart-of-Account by code(s). @private */
  async _acc(businessId, codes) {
    return ChartOfAccount.findOne({ businessId, accountCode: { $in: Array.isArray(codes) ? codes : [codes] } }).lean();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // VOID
  // ───────────────────────────────────────────────────────────────────────────
  async voidDocument(kind, doc, reason, user, ipAddress) {
    const isInvoice = kind === 'invoice';
    const STATES = isInvoice ? INVOICE_STATES : BILL_STATES;
    if (doc.state === STATES.VOIDED) throw new ApiError(409, `This ${kind} is already voided`);

    const recognitionId = isInvoice
      ? (doc.arJournalId || doc.linkedJournalEntryId)
      : (doc.apLiabilityJournalId || doc.linkedJournalEntryId);
    if (!recognitionId) throw new ApiError(400, `Cannot void a ${kind} that has not been posted to the ledger`);

    const businessId = doc.businessId;
    const total = r2(doc.totalAmount);
    const tax   = r2(doc.taxAmount || 0);
    const net   = r2(total - tax);
    const paid  = r2(doc.paidAmount || 0);
    const remaining = r2(doc.remainingBalance != null ? doc.remainingBalance : total);

    const recog = await JournalEntry.findById(recognitionId).lean();
    const control = await this._acc(businessId, isInvoice ? '1110' : '2110'); // AR / AP
    if (!control) throw new ApiError(400, `${isInvoice ? 'Accounts Receivable' : 'Accounts Payable'} account not found`);
    // Revenue (invoice) = recognition.creditAccountId; Expense (bill) = recognition.debitAccountId.
    const incomeExpenseId = recog ? (isInvoice ? recog.creditAccountId : recog.debitAccountId) : null;
    const taxAcc = tax > 0 ? await this._acc(businessId, isInvoice ? '2120' : ['1170', '1171', '1172']) : null;
    const cashAcc = paid > 0 ? await this._acc(businessId, ['1010', '1020', '1040', '1030']) : null;

    const numberRef = doc.invoiceNumber || doc.billNumber;
    const common = {
      businessId, transactionDate: new Date(), status: JOURNAL_STATUS.POSTED,
      transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED, invoiceNumber: numberRef,
      currencyCode: doc.currencyCode || 'PKR', exchangeRate: doc.exchangeRate || 1,
      createdBy: user._id, lastModifiedBy: user._id,
      ...(isInvoice ? { customerId: doc.customerId } : { vendorId: doc.vendorId }),
    };
    const jeIds = [];

    // 1. Reverse recognition (net)
    if (net > 0 && incomeExpenseId) {
      const je = await postBalancedJournal({
        ...common, description: `Void ${numberRef} — reverse recognition`,
        // A document is voided once, so each leg is keyed on it. Without a key a
        // retry reverses recognition twice and drives AR/AP the wrong way.
        idempotencyKey: `void:${doc._id}:recognition`,
        transactionType: isInvoice ? TRANSACTION_TYPES.CREDIT_SALE : TRANSACTION_TYPES.CREDIT_PURCHASE,
        amount: net,
        debitAccountId:  isInvoice ? incomeExpenseId : control._id,  // invoice: DR Revenue | bill: DR AP
        creditAccountId: isInvoice ? control._id : incomeExpenseId,  // invoice: CR AR      | bill: CR Expense
      });
      jeIds.push(je._id);
    }
    // 2. Reverse recognition tax
    if (tax > 0 && taxAcc) {
      const je = await postBalancedJournal({
        ...common, description: `Void ${numberRef} — reverse tax`,
        idempotencyKey: `void:${doc._id}:tax`,
        transactionType: isInvoice ? TRANSACTION_TYPES.CREDIT_SALE : TRANSACTION_TYPES.CREDIT_PURCHASE,
        amount: tax,
        debitAccountId:  isInvoice ? taxAcc._id : control._id,
        creditAccountId: isInvoice ? control._id : taxAcc._id,
      });
      jeIds.push(je._id);
    }
    // 3. Reverse settlements (refund customer / reclaim from vendor)
    if (paid > 0 && cashAcc) {
      const je = await postBalancedJournal({
        ...common, description: `Void ${numberRef} — reverse payment`,
        idempotencyKey: `void:${doc._id}:payment`,
        transactionType: isInvoice ? TRANSACTION_TYPES.PAYMENT_RECEIVED : TRANSACTION_TYPES.PAYMENT_MADE,
        amount: paid,
        debitAccountId:  isInvoice ? control._id : cashAcc._id,   // invoice: DR AR / CR Cash (refund)
        creditAccountId: isInvoice ? cashAcc._id : control._id,   // bill: DR Cash / CR AP (reclaim)
      });
      jeIds.push(je._id);
    }

    // Unwind the party balance by the still-outstanding amount.
    if (remaining > 0) {
      if (isInvoice) {
        await partyBalanceService.adjustReceivable(businessId, doc.customerId, -remaining, { userId: user._id, reason: 'invoice_voided', entityType: ENTITY_TYPES.INVOICE, entityId: doc._id });
      } else {
        await partyBalanceService.adjustPayable(businessId, doc.vendorId, -remaining, { userId: user._id, reason: 'bill_voided', entityType: ENTITY_TYPES.BILL, entityId: doc._id });
      }
    }

    // Mark voided — records preserved.
    doc.voidJournalEntryIds = (doc.voidJournalEntryIds || []).concat(jeIds);
    doc.voidedAt = new Date();
    doc.voidReason = reason || null;
    doc.remainingBalance = 0;
    if (typeof doc.recordStateChange === 'function') doc.recordStateChange(STATES.VOIDED, user, reason || 'Voided');
    doc.state = STATES.VOIDED;
    doc.lastModifiedBy = user._id;
    await doc.save();

    await this._audit(doc, kind, AUDIT_ACTIONS.VOIDED, user, ipAddress, { reason, reversalJournalEntries: jeIds.length, refunded: paid });
    businessEvents.emit(isInvoice ? EVENTS.INVOICE_VOIDED : EVENTS.BILL_VOIDED, {
      businessId: String(businessId), userId: user._id,
      entityType: isInvoice ? ENTITY_TYPES.INVOICE : ENTITY_TYPES.BILL, entityId: doc._id,
      number: numberRef, reversedAmount: total, refunded: paid,
    });
    return doc;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CREDIT MEMO (apply to a document as a non-cash settlement)
  // ───────────────────────────────────────────────────────────────────────────
  async applyCreditMemo(kind, doc, amount, reason, user, ipAddress) {
    const isInvoice = kind === 'invoice';
    const STATES = isInvoice ? INVOICE_STATES : BILL_STATES;
    const amt = r2(amount);
    if (!(amt > 0)) throw new ApiError(400, 'Credit memo amount must be greater than zero');
    if ([STATES.VOIDED, STATES.CANCELLED].includes(doc.state)) {
      throw new ApiError(409, `Cannot apply a credit memo to a ${doc.state} ${kind}`);
    }
    const remaining = r2(doc.remainingBalance != null ? doc.remainingBalance : doc.totalAmount);
    if (amt > remaining + 0.001) throw new ApiError(400, `Credit memo (${amt}) exceeds the outstanding balance (${remaining})`);

    const businessId = doc.businessId;
    const control = await this._acc(businessId, isInvoice ? '1110' : '2110');
    const contra = await this._acc(businessId, isInvoice ? '4115' : ['5100', '5000', '6100']); // Sales Returns / Expense
    if (!control || !contra) throw new ApiError(400, 'Required accounts (control / returns) not found');

    const numberRef = doc.invoiceNumber || doc.billNumber;
    // Customer: DR Sales Returns / CR AR ; Vendor: DR AP / CR Expense
    const je = await postBalancedJournal({
      businessId, transactionDate: new Date(),
      description: `Credit memo — ${numberRef}`,
      transactionType: isInvoice ? TRANSACTION_TYPES.CREDIT_SALE : TRANSACTION_TYPES.CREDIT_PURCHASE,
      amount: amt,
      debitAccountId:  isInvoice ? contra._id : control._id,
      creditAccountId: isInvoice ? control._id : contra._id,
      status: JOURNAL_STATUS.POSTED, transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
      invoiceNumber: numberRef, currencyCode: doc.currencyCode || 'PKR', exchangeRate: doc.exchangeRate || 1,
      createdBy: user._id, lastModifiedBy: user._id,
      ...(isInvoice ? { customerId: doc.customerId } : { vendorId: doc.vendorId }),
      // Keyed on the memo's SEQUENCE, not the document: a document may carry
      // several partial credit memos, so `credit-memo:{docId}` alone would block
      // the second legitimate one. The index is taken before the append below,
      // so retrying the Nth memo returns the Nth journal while a genuinely new
      // memo gets a new key.
      idempotencyKey: `credit-memo:${doc._id}:${(doc.creditMemos || []).length}`,
    });

    // Apply as a non-cash settlement.
    const newRemaining = r2(remaining - amt);
    doc.creditMemos = (doc.creditMemos || []).concat([{ amount: amt, reason: reason || null, journalEntryId: je._id, appliedAt: new Date(), createdBy: user._id }]);
    doc.paidAmount = Math.min(r2((doc.paidAmount || 0) + amt), r2(doc.totalAmount));
    doc.remainingBalance = Math.max(0, newRemaining);
    const target = newRemaining <= 0.009 ? STATES.PAID : STATES.PARTIALLY_PAID;
    const Model = doc.constructor;
    if (target !== doc.state && Model.canTransition(doc.state, target)) {
      doc.recordStateChange(target, user, 'Credit memo applied');
      doc.state = target;
    }
    doc.lastModifiedBy = user._id;
    await doc.save();

    if (isInvoice) {
      await partyBalanceService.adjustReceivable(businessId, doc.customerId, -amt, { userId: user._id, reason: 'credit_memo', entityType: ENTITY_TYPES.INVOICE, entityId: doc._id });
    } else {
      await partyBalanceService.adjustPayable(businessId, doc.vendorId, -amt, { userId: user._id, reason: 'credit_memo', entityType: ENTITY_TYPES.BILL, entityId: doc._id });
    }

    await this._audit(doc, kind, AUDIT_ACTIONS.CREDIT_APPLIED, user, ipAddress, { amount: amt, reason });
    businessEvents.emit(EVENTS.CREDIT_MEMO_APPLIED, {
      businessId: String(businessId), userId: user._id,
      entityType: isInvoice ? ENTITY_TYPES.INVOICE : ENTITY_TYPES.BILL, entityId: doc._id,
      number: numberRef, amount: amt, kind: isInvoice ? 'customer' : 'vendor',
    });
    return doc;
  }

  async _audit(doc, kind, action, user, ipAddress, after) {
    try {
      await auditService.log({
        businessId: doc.businessId,
        entityType: kind === 'invoice' ? ENTITY_TYPES.INVOICE : ENTITY_TYPES.BILL,
        entityId: doc._id, action, performedBy: user._id,
        performedByName: user.fullName || user.email || 'User', afterState: after, ipAddress,
      });
    } catch (e) {
      // best-effort: audit-log write is observability only; the void/credit action was already committed.
      logger.warn(`[arApVoidCredit] audit failed: ${e.message}`);
    }
  }
}

module.exports = new ArApVoidCreditService();

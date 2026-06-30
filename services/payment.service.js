/**
 * payment.service.js — AR/AP Domain Refactor, Milestone M2.
 *
 * The first-class Payment orchestrator. A Payment records money received from a
 * customer (inbound) or paid to a vendor (outbound) and APPLIES it across one or
 * many open documents, with partial amounts and overpayment held on account.
 *
 * NON-NEGOTIABLE DESIGN RULES:
 *   • The Payment is NOT a ledger source of truth. Every allocation delegates to
 *     the proven settlement primitive transaction.recordPartialPayment, which
 *     posts the balanced JournalEntry, updates the parent's settlements + party
 *     balance, and (M1) reconciles the linked Invoice/Bill. Overpayment posts an
 *     advance JE via ledgerPosting. JournalEntry stays the immutable GL projection.
 *   • VALIDATE-FIRST: every allocation is fully validated (party match, sufficient
 *     remaining balance, account resolution) BEFORE a single ledger write — the
 *     primary rollback guarantee.
 *   • ROLLBACK SAFETY: if a write fails mid-apply (e.g. concurrency / infra), the
 *     applied settlements are reversed (best-effort) and the Payment is marked
 *     `void`. True multi-document atomicity requires MongoDB transactions
 *     (sessions / replica set) — noted as the production hardening step.
 */

'use strict';

const Payment = require('../models/Payment.model');
const Invoice = require('../models/Invoice.model');
const Bill = require('../models/Bill.model');
const JournalEntry = require('../models/JournalEntry.model');
const ChartOfAccount = require('../models/ChartOfAccount.model');
const customerRepository = require('../repositories/customer.repository');
const vendorRepository = require('../repositories/vendor.repository');
const { postBalancedJournal } = require('./ledgerPosting.service');
const auditService = require('./audit.service');
const { businessEvents, EVENTS } = require('./businessEventEngine.service');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const {
  TRANSACTION_TYPES, TRANSACTION_SOURCES, JOURNAL_STATUS, ENTITY_TYPES, AUDIT_ACTIONS,
} = require('../config/constants');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

class PaymentService {
  // ───────────────────────────────────────────────────────────────────────────
  // Public API
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Record + apply a payment across one or many documents.
   *
   * @param {string} businessId
   * @param {Object} data
   *   { paymentDate, amount, cashAccountId|paymentAccountId, method, reference,
   *     currencyCode, exchangeRate, notes,
   *     allocations: [{ documentType?, documentId?, parentTransactionId?, amount }] }
   * @param {string} userId
   * @param {string} ipAddress
   * @returns {Promise<Payment>}  the persisted Payment (with non-persisted
   *                              `_appliedTransactions` for callers that need them)
   */
  async recordPayment(businessId, data, userId, ipAddress) {
    const resolved = await this._validateAndResolve(businessId, data);

    const paymentNumber = await Payment.nextPaymentNumber(businessId);
    const payment = await Payment.create({
      businessId,
      paymentNumber,
      direction:    resolved.direction,
      partyType:    resolved.partyType,
      partyId:      resolved.partyId,
      partySnapshot:resolved.partySnapshot,
      paymentDate:  data.paymentDate || new Date(),
      amount:       resolved.amount,
      currencyCode: (data.currencyCode || 'PKR').toUpperCase(),
      exchangeRate: data.exchangeRate || 1,
      method:       data.method || 'bank_transfer',
      reference:    data.reference || null,
      cashAccountId:resolved.cashAccountId,
      allocations:  resolved.allocations, // amounts set; settlementTransactionId null
      notes:        data.notes || null,
      createdBy:    userId,
      lastModifiedBy: userId,
    });

    const appliedTxs = [];
    try {
      const txService = require('./transaction.service'); // lazy — avoid require cycle

      // Apply each allocation through the proven settlement primitive.
      for (const alloc of payment.allocations) {
        const childTx = await txService.recordPartialPayment(
          alloc.parentJournalEntryId,
          businessId,
          {
            amount:           alloc.amount,
            paymentAccountId: resolved.cashAccountId,
            transactionDate:  payment.paymentDate,
            reference:        data.reference || null,
            description:      `Payment ${payment.paymentNumber}`,
          },
          userId,
          ipAddress
        );
        alloc.settlementTransactionId = childTx._id;
        appliedTxs.push(childTx);
      }

      // Overpayment → hold on account via an advance journal (keeps Cash whole).
      if (resolved.unappliedAmount > 0.009) {
        const advJe = await this._postUnappliedAdvance(payment, resolved, userId);
        payment.unappliedJournalEntryId = advJe ? advJe._id : null;
      }

      payment.lastModifiedBy = userId;
      await payment.save(); // recomputes allocatedAmount / unappliedAmount / status
    } catch (err) {
      await this._compensate(payment, appliedTxs, businessId, userId, ipAddress, err);
      throw err;
    }

    // Audit (best-effort) + broadcast.
    try {
      await auditService.log({
        businessId,
        entityType:      ENTITY_TYPES.PAYMENT,
        entityId:        payment._id,
        action:          AUDIT_ACTIONS.PAYMENT_APPLIED,
        performedBy:     userId,
        afterState: {
          paymentNumber: payment.paymentNumber, direction: payment.direction,
          amount: payment.amount, allocated: payment.allocatedAmount,
          unapplied: payment.unappliedAmount, allocations: payment.allocations.length,
        },
        ipAddress,
      });
    } catch (e) {
      logger.warn(`[payment] audit log failed for ${payment.paymentNumber}: ${e.message}`);
    }

    businessEvents.emit(EVENTS.PAYMENT_APPLIED, {
      businessId:      String(businessId),
      userId,
      entityType:      ENTITY_TYPES.PAYMENT,
      entityId:        payment._id,
      paymentNumber:   payment.paymentNumber,
      direction:       payment.direction,
      partyId:         payment.partyId,
      amount:          payment.amount,
      allocatedAmount: payment.allocatedAmount,
      unappliedAmount: payment.unappliedAmount,
      allocationCount: payment.allocations.length,
    });

    payment._appliedTransactions = appliedTxs; // non-persisted convenience for the legacy adapter
    return payment;
  }

  /**
   * Backward-compatible single-allocation adapter for the legacy
   * POST /transactions/payment endpoint. Records a first-class Payment and
   * returns the underlying child settlement transaction (the legacy response).
   */
  async recordLegacyPayment(parentTransactionId, businessId, paymentData, userId, ipAddress) {
    const payment = await this.recordPayment(
      businessId,
      {
        amount:        paymentData.amount,
        cashAccountId: paymentData.paymentAccountId,
        paymentDate:   paymentData.transactionDate || new Date(),
        method:        paymentData.method,
        reference:     paymentData.reference || null,
        notes:         paymentData.notes || paymentData.description || null,
        allocations:   [{ parentTransactionId, amount: paymentData.amount }],
      },
      userId,
      ipAddress
    );
    // Preserve the legacy contract: return the child settlement transaction.
    return payment._appliedTransactions && payment._appliedTransactions[0]
      ? payment._appliedTransactions[0]
      : payment;
  }

  /**
   * Phase 2 - Accounts Receivable: Auto-Allocate a lump sum payment.
   * Fetches open invoices (or bills) for the party, oldest first, and automatically
   * builds the allocations array, then records the payment.
   */
  async autoAllocatePayment(businessId, partyType, partyId, paymentData, userId, ipAddress) {
    const amount = r2(paymentData.amount);
    if (!(amount > 0)) throw new ApiError(400, 'Payment amount must be greater than zero');

    const DocumentModel = partyType === 'vendor' ? Bill : Invoice;
    const query = {
      businessId,
      [partyType === 'vendor' ? 'vendorId' : 'customerId']: partyId,
      state: { $in: ['approved', 'partially_paid'] },
      remainingBalance: { $gt: 0 },
      isArchived: false,
    };
    const openDocs = await DocumentModel.find(query).sort({ dueDate: 1, issueDate: 1 }).lean();

    const allocations = [];
    let remainingToAllocate = amount;

    for (const doc of openDocs) {
      if (remainingToAllocate <= 0) break;

      const allocAmount = Math.min(doc.remainingBalance, remainingToAllocate);
      allocations.push({
        documentType: partyType === 'vendor' ? 'bill' : 'invoice',
        documentId: doc._id,
        amount: r2(allocAmount),
      });

      remainingToAllocate = r2(remainingToAllocate - allocAmount);
    }

    if (allocations.length === 0) {
      throw new ApiError(400, 'No open documents found to auto-allocate this payment.');
    }

    const dataWithAllocations = {
      ...paymentData,
      allocations,
    };

    return await this.recordPayment(businessId, dataWithAllocations, userId, ipAddress);
  }

  // ════════════════════════════════════════════════════════════════════════════════
  // Validation + resolution (no writes — the primary rollback guarantee)
  // ════════════════════════════════════════════════════════════════════════════════

  async _validateAndResolve(businessId, data) {
    const amount = r2(data.amount);
    if (!(amount > 0)) throw new ApiError(400, 'Payment amount must be greater than zero');

    const cashAccountId = data.cashAccountId || data.paymentAccountId;
    if (!cashAccountId) throw new ApiError(400, 'A cash/bank account (cashAccountId) is required');

    const specs = Array.isArray(data.allocations) ? data.allocations : [];
    if (specs.length === 0) throw new ApiError(400, 'At least one allocation is required');

    const resolvedAllocations = [];
    let direction = null;
    let partyId = null;
    let allocatedTotal = 0;
    // Accumulate allocations per target JE so several allocations to the SAME
    // document in one payment are validated against its balance as a SUM, not
    // each in isolation (each spec re-reads the same pre-settlement balance, so
    // an individual check can't see the others and would over-settle the parent).
    const perJeAllocated = new Map();

    for (const spec of specs) {
      const allocAmount = r2(spec.amount);
      if (!(allocAmount > 0)) throw new ApiError(400, 'Each allocation amount must be greater than zero');

      // Resolve the parent recognition JE (by document or directly by JE id).
      let je = null;
      let doc = null;
      let documentType = spec.documentType || null;

      if (spec.parentTransactionId) {
        je = await JournalEntry.findOne({ _id: spec.parentTransactionId, businessId }).lean();
        if (!je) throw new ApiError(404, `Parent transaction ${spec.parentTransactionId} not found`);
      } else if (spec.documentId && documentType) {
        const Model = documentType === 'invoice' ? Invoice : Bill;
        doc = await Model.findOne({ _id: spec.documentId, businessId });
        if (!doc) throw new ApiError(404, `${documentType} ${spec.documentId} not found`);
        if (!doc.linkedJournalEntryId) {
          throw new ApiError(400, `${documentType} ${doc[documentType === 'invoice' ? 'invoiceNumber' : 'billNumber']} has no posted journal entry to settle`);
        }
        je = await JournalEntry.findOne({ _id: doc.linkedJournalEntryId, businessId }).lean();
        if (!je) throw new ApiError(404, 'Linked journal entry not found for the document');
      } else {
        throw new ApiError(400, 'Each allocation needs either { documentType, documentId } or { parentTransactionId }');
      }

      // The JE must be an AR/AP recognition entry with a tracked balance.
      const isAR = je.transactionType === TRANSACTION_TYPES.CREDIT_SALE;
      const isAP = je.transactionType === TRANSACTION_TYPES.CREDIT_PURCHASE;
      if (!isAR && !isAP) throw new ApiError(400, 'Allocations must target a credit sale (invoice) or credit purchase (bill)');
      if (je.remainingBalance == null) throw new ApiError(400, 'Target entry does not track an outstanding balance');
      const jeKey = String(je._id);
      const cumulativeForJe = r2((perJeAllocated.get(jeKey) || 0) + allocAmount);
      if (cumulativeForJe > r2(je.remainingBalance) + 0.001) {
        throw new ApiError(400, `Allocation${perJeAllocated.has(jeKey) ? 's' : ''} (${cumulativeForJe}) exceed${perJeAllocated.has(jeKey) ? '' : 's'} the outstanding balance (${r2(je.remainingBalance)}) of ${je.invoiceNumber || 'the document'}`);
      }
      perJeAllocated.set(jeKey, cumulativeForJe);

      const thisDirection = isAR ? 'inbound' : 'outbound';
      // An unlinked AR/AP entry (no customer/vendor — e.g. a manual credit-sale
      // journal) can still be settled: we post the cash receipt and reduce the
      // outstanding, just without touching any party subledger. partyId stays null.
      const thisPartyId = (isAR ? je.customerId : je.vendorId) || null;
      const thisPartyKey = thisPartyId ? String(thisPartyId) : null;

      // A single payment is for a single party and a single direction (AR or AP).
      if (direction === null) { direction = thisDirection; partyId = thisPartyKey; }
      else {
        if (direction !== thisDirection) throw new ApiError(400, 'A payment cannot mix receivable and payable allocations');
        if (partyId !== thisPartyKey) throw new ApiError(400, 'All allocations of a payment must be for the same party');
      }

      if (!documentType) documentType = isAR ? 'invoice' : 'bill';
      // Best-effort document link (may be absent for legacy JE-only data).
      if (!doc) {
        const Model = isAR ? Invoice : Bill;
        doc = await Model.findOne({ businessId, linkedJournalEntryId: je._id }).lean();
      }

      resolvedAllocations.push({
        documentType,
        documentId:           doc ? doc._id : null,
        documentNumber:       doc ? (doc.invoiceNumber || doc.billNumber) : (je.invoiceNumber || null),
        parentJournalEntryId: je._id,
        amount:               allocAmount,
      });
      allocatedTotal = r2(allocatedTotal + allocAmount);
    }

    if (allocatedTotal > amount + 0.001) {
      throw new ApiError(400, `Allocations (${allocatedTotal}) exceed the payment amount (${amount})`);
    }

    // Validate the cash account exists for this business.
    const cashAcc = await ChartOfAccount.findOne({ _id: cashAccountId, businessId }).lean();
    if (!cashAcc) throw new ApiError(400, 'cashAccountId does not belong to this business');

    const partySnapshot = await this._partySnapshot(businessId, direction, partyId);

    return {
      direction,
      partyType: direction === 'inbound' ? 'customer' : 'vendor',
      partyId,
      partySnapshot,
      cashAccountId,
      amount,
      unappliedAmount: r2(amount - allocatedTotal),
      allocations: resolvedAllocations,
    };
  }

  async _partySnapshot(businessId, direction, partyId) {
    if (!partyId) return {}; // unlinked AR/AP entry — no party to snapshot
    try {
      if (direction === 'inbound') {
        const c = await customerRepository.findByBusinessAndId(businessId, partyId);
        return c ? { name: c.fullName || c.businessName || null, email: c.email || null } : {};
      }
      const v = await vendorRepository.findByBusinessAndId(businessId, partyId);
      return v ? { name: v.vendorName || null, email: v.email || null } : {};
    } catch { return {}; }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Overpayment (on-account) advance journal
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Post the advance journal for the unapplied portion so Cash is fully accounted.
   *   inbound  (customer overpaid): DR Cash / CR Advance from Customers (2190)
   *   outbound (we overpaid vendor): DR Advance to Suppliers (1160) / CR Cash
   * @private
   */
  async _postUnappliedAdvance(payment, resolved, userId) {
    const inbound = resolved.direction === 'inbound';
    const advanceCode = inbound ? '2190' : '1160';
    const [cashAcc, advAcc] = await Promise.all([
      ChartOfAccount.findOne({ _id: resolved.cashAccountId, businessId: payment.businessId }).lean(),
      ChartOfAccount.findOne({ businessId: payment.businessId, accountCode: advanceCode }).lean(),
    ]);
    if (!cashAcc || !advAcc) {
      logger.warn(`[payment] unapplied advance JE skipped for ${payment.paymentNumber} — cash or advance account (${advanceCode}) missing`);
      return null;
    }

    return postBalancedJournal({
      businessId:        payment.businessId,
      transactionDate:   payment.paymentDate,
      description:       `Unapplied ${inbound ? 'receipt' : 'payment'} — ${payment.paymentNumber}`,
      transactionType:   inbound ? TRANSACTION_TYPES.PAYMENT_RECEIVED : TRANSACTION_TYPES.PAYMENT_MADE,
      amount:            resolved.unappliedAmount,
      debitAccountId:    inbound ? cashAcc._id : advAcc._id,
      creditAccountId:   inbound ? advAcc._id : cashAcc._id,
      status:            JOURNAL_STATUS.POSTED,
      transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
      customerId:        inbound ? resolved.partyId : null,
      vendorId:          inbound ? null : resolved.partyId,
      currencyCode:      payment.currencyCode,
      exchangeRate:      payment.exchangeRate,
      createdBy:         userId,
      lastModifiedBy:    userId,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Rollback / compensation
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Best-effort compensation when an apply fails part-way: reverse the settlement
   * transactions already posted, then mark the Payment void. (Residual parent
   * balance drift, if any, is detectable by the M1 reconciliation; full atomicity
   * needs MongoDB transactions.) @private
   */
  async _compensate(payment, appliedTxs, businessId, userId, ipAddress, err) {
    logger.error(`[payment] ${payment.paymentNumber} apply failed: ${err.message} — compensating ${appliedTxs.length} settlement(s)`);
    const txService = require('./transaction.service');
    for (const tx of appliedTxs) {
      try {
        await txService.deleteTransaction(tx._id, businessId, userId, ipAddress);
      } catch (e) {
        logger.error(`[payment] compensation reverse failed for settlement ${tx._id}: ${e.message}`);
      }
    }
    if (payment.unappliedJournalEntryId) {
      try { await txService.deleteTransaction(payment.unappliedJournalEntryId, businessId, userId, ipAddress); }
      catch (e) { logger.error(`[payment] compensation reverse failed for advance JE: ${e.message}`); }
    }
    try {
      payment.status = 'void';
      payment.voidReason = `Rolled back during apply: ${err.message}`;
      payment.lastModifiedBy = userId;
      await payment.save();
    } catch (e) {
      logger.error(`[payment] failed to mark ${payment.paymentNumber} void: ${e.message}`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Read APIs
  // ───────────────────────────────────────────────────────────────────────────

  async getById(id, businessId) {
    const payment = await Payment.findOne({ _id: id, ...(businessId ? { businessId } : {}) });
    if (!payment) throw new ApiError(404, 'Payment not found');
    return payment;
  }

  async list(businessId, filters = {}, pagination = {}) {
    const { page = 1, limit = 25 } = pagination;
    const q = { businessId, isArchived: { $ne: true } };
    if (filters.direction) q.direction = filters.direction;
    if (filters.partyId)   q.partyId = filters.partyId;
    if (filters.status)    q.status = filters.status;
    if (filters.startDate || filters.endDate) {
      q.paymentDate = {};
      if (filters.startDate) q.paymentDate.$gte = new Date(filters.startDate);
      if (filters.endDate)   q.paymentDate.$lte = new Date(filters.endDate);
    }
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      Payment.find(q).sort({ paymentDate: -1, createdAt: -1 }).skip(skip).limit(limit),
      Payment.countDocuments(q),
    ]);
    return { data, total, page, limit };
  }
}

module.exports = new PaymentService();

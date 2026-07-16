// services/bill.service.js
//
// Phase 1 — Bill domain service (Accounts Payable counterpart of invoice.service).
//
// Public API mirrors invoice.service:
//   createDraft, submitForApproval, approve, reject, schedule, markPaid,
//   cancel, softDelete, transitionState, getById, list, syncFromJournalEntry,
//   getTimeline.
//
const mongoose = require('mongoose');
const Bill = require('../models/Bill.model');
const ChartOfAccount = require('../models/ChartOfAccount.model');
const vendorRepository = require('../repositories/vendor.repository');
const auditService = require('./audit.service');
const billMatchingService = require('./billMatching.service');
const partyBalanceService = require('./partyBalance.service');     // ERP Step 4 — centralized AP balance
const { postBalancedJournal, postCompoundJournal } = require('./ledgerPosting.service'); // ERP Step 4 — JE + running-balance sync; A13 — compound GRNI-clearing AP entry
const accountResolver = require('./accountResolver.service');       // resolve-or-seed; never skip a posting
const accountRepo = require('../repositories/account.repository');  // A13 — resolve / back-fill GRNI (2115)
const { withTransaction } = require('../utils/withTransaction');   // R-01 — atomic recognition unit
const { businessEvents, EVENTS } = require('./businessEventEngine.service'); // ERP Step 4 — event broadcasts
const { ApiError } = require('../utils/ApiError');
const { validateDocumentData, assertNoDuplicateNumber, assertPartyExists } = require('../utils/arApValidation'); // M4
const paymentTermsUtil = require('../utils/paymentTerms'); // M8 — structured payment terms
const { toBaseAmount } = require('../utils/currency.util'); // F2 — ledger is base currency
const logger = require('../config/logger');
const {
  BILL_STATES,
  APPROVAL_STATUS,
  AUDIT_ACTIONS,
  ENTITY_TYPES,
  DEFAULT_APPROVAL_THRESHOLD,
  TRANSACTION_TYPES,
  TRANSACTION_SOURCES,
  JOURNAL_STATUS,
  THREE_WAY_MATCH_STATUSES,
} = require('../config/constants');

class BillService {
  // ───────────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────────

  _requiresApproval(amount, businessConfig = {}) {
    const threshold = Number.isFinite(businessConfig.billApprovalThreshold)
      ? businessConfig.billApprovalThreshold
      : DEFAULT_APPROVAL_THRESHOLD;
    return amount >= threshold;
  }

  async _vendorSnapshot(businessId, vendorId) {
    if (!vendorId) return {};
    const v = await vendorRepository.findByBusinessAndId(businessId, vendorId);
    if (!v) return {};
    return {
      vendorName: v.vendorName || null,
      email:      v.email || null,
      phone:      v.phone || null,
      taxId:      v.taxId || null,
      strn:       v.whtProfile?.strn || null,
    };
  }

  _guardTransition(bill, toState) {
    if (!Bill.canTransition(bill.state, toState)) {
      throw new ApiError(
        409,
        `Illegal state transition: bill ${bill._id} cannot move from "${bill.state}" to "${toState}"`
      );
    }
  }

  async _applyStateChange(bill, toState, user, { reason = null, ipAddress = null, session = null } = {}) {
    this._guardTransition(bill, toState);
    const fromState = bill.state;
    bill.recordStateChange(toState, user, reason);
    bill.state = toState;
    bill.lastModifiedBy = user._id;
    await bill.save({ session });
    try {
      await auditService.log({
        businessId:      bill.businessId,
        entityType:      ENTITY_TYPES.BILL,
        entityId:        bill._id,
        action:          AUDIT_ACTIONS.STATE_CHANGED,
        performedBy:     user._id,
        performedByName: user.fullName || user.email || 'Unknown User',
        beforeState:     { state: fromState },
        afterState:      { state: toState, reason },
        ipAddress,
      });
    } catch (e) {
      // best-effort: audit-log write is observability only; the bill state was already persisted above.
      logger.warn(`[bill] audit log failed for state change ${fromState}→${toState}: ${e.message}`);
    }
    return bill;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Creation
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Auto-generate a unique bill number for a business.
   * Format: BILL-YYYYMM-NNNNN (sequential within the calendar month).
   * @private
   */
  async _generateBillNumber(businessId) {
    const now = new Date();
    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const last = await Bill.findOne({
      businessId,
      billNumber: { $regex: `^BILL-${yyyymm}-` },
    }).sort({ createdAt: -1 }).select('billNumber').lean();

    let seq = 1;
    if (last?.billNumber) {
      const n = parseInt(last.billNumber.split('-').pop(), 10);
      if (!isNaN(n)) seq = n + 1;
    }
    return `BILL-${yyyymm}-${String(seq).padStart(5, '0')}`;
  }

  async createDraft(data, user, ipAddress) {
    const hasLines = Array.isArray(data.lineItems) && data.lineItems.length > 0;

    // Auto-generate bill number if the caller omitted it
    if (!data.billNumber?.trim()) {
      data.billNumber = await this._generateBillNumber(data.businessId);
    }

    // ── M4 enterprise validation (service layer) ─────────────────────────────
    validateDocumentData(data, { kind: 'bill', isUpdate: false });
    await assertNoDuplicateNumber(Bill, data.businessId, data.billNumber, 'billNumber');
    await assertPartyExists(vendorRepository, data.businessId, data.vendorId, 'Vendor');

    const snap = await this._vendorSnapshot(data.businessId, data.vendorId);

    // ── M8 — structured payment terms drive dueDate + early-pay discount ──────
    let termsSnapshot;
    let derivedDueDate = data.dueDate || null;
    if (data.paymentTermsCode || data.paymentTerms) {
      termsSnapshot = paymentTermsUtil.buildSnapshot(data.paymentTermsCode || data.paymentTerms);
      termsSnapshot.discountDeadline = paymentTermsUtil.computeDiscountDeadline(data.issueDate, termsSnapshot);
      if (!derivedDueDate) derivedDueDate = paymentTermsUtil.computeDueDate(data.issueDate, termsSnapshot);
    }

    const estimateAmount = data.amount || (hasLines
      ? data.lineItems.reduce((s, li) => s + (li.quantity || 0) * (li.unitPrice || 0), 0)
      : 0);
    const approvalRequired = this._requiresApproval(estimateAmount, data.businessConfig);

    const bill = new Bill({
      businessId:           data.businessId,
      billNumber:           data.billNumber,
      vendorReferenceNumber:data.vendorReferenceNumber || null,
      linkedJournalEntryId: data.linkedJournalEntryId || null,
      vendorId:             data.vendorId || null,
      vendorSnapshot:       Object.keys(snap).length ? snap : data.vendorSnapshot || {},

      lineItems:            hasLines ? data.lineItems : [],
      amount:               hasLines ? 0.01 : data.amount,
      taxAmount:            data.taxAmount || 0,
      whtAmount:            data.whtAmount || 0,
      currencyCode:         data.currencyCode || 'PKR',

      invoiceDiscountType:  data.invoiceDiscountType || null,
      invoiceDiscountValue: data.invoiceDiscountValue || 0,
      shippingCharges:      data.shippingCharges || 0,
      roundingAdjustment:   data.roundingAdjustment || 0,
      exchangeRate:         data.exchangeRate || 1,
      attachments:          data.attachments || [],

      issueDate:            data.issueDate,
      dueDate:              derivedDueDate,
      paymentTerms:         termsSnapshot || undefined,
      state:                BILL_STATES.DRAFT,
      approvalRequired,
      approvalStatus:       approvalRequired ? APPROVAL_STATUS.PENDING : APPROVAL_STATUS.NOT_REQUIRED,
      approvalThreshold:    approvalRequired ? (data.businessConfig?.billApprovalThreshold ?? DEFAULT_APPROVAL_THRESHOLD) : null,
      description:          data.description || null,
      notes:                data.notes || null,
      tags:                 data.tags || [],
      createdBy:            user._id,
      lastModifiedBy:       user._id,
    });
    bill.recordStateChange(BILL_STATES.DRAFT, user, 'Initial creation');
    await bill.save();
    try {
      await auditService.logCreate(
        ENTITY_TYPES.BILL,
        bill._id,
        bill.businessId,
        user._id,
        bill.toObject(),
        ipAddress
      );
    } catch (e) {
      // best-effort: audit-log write is observability only; the bill document was already persisted.
      logger.warn(`[bill] audit logCreate failed: ${e.message}`);
    }
    return bill;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Approval workflow
  // ───────────────────────────────────────────────────────────────────────────

  async submitForApproval(id, user, ipAddress, opts = {}) {
    const bill = await this._loadOrThrow(id, user?.businessId);
    if (!bill.approvalRequired) {
      // Landing in `approved` IS the recognition event, whichever door it came
      // through — so this path must post the AP liability exactly like approve()
      // does. It previously returned here, leaving every below-threshold bill
      // approved with no payable in the GL.
      await this._applyStateChange(bill, BILL_STATES.APPROVED, user, {
        reason: 'Below approval threshold — auto-approved',
        ipAddress,
      });
      return this._recognizeApprovedBill(bill, user, ipAddress);
    }
    bill.approvalLog.push({
      action:    'submitted',
      actorId:   user._id,
      actorName: user.fullName || user.email || 'Unknown',
      actorRole: user.role || null,
      timestamp: new Date(),
    });
    bill.approvalStatus = APPROVAL_STATUS.PENDING;
    // M6 — build the multi-level approval chain when explicitly requested (opt-in).
    if (opts.multiLevel && (!bill.approvalChain || bill.approvalChain.length === 0)) {
      const approvalEngine = require('./approvalEngine.service');
      bill.approvalChain = approvalEngine.buildChain(bill.totalAmount || bill.amount || 0, opts);
    }
    return this._applyStateChange(bill, BILL_STATES.AWAITING_APPROVAL, user, { ipAddress });
  }

  /** M6 — act on the multi-level approval chain (reject/reassign/escalate). */
  async actOnApproval(id, action, user, { note, level } = {}, ipAddress) {
    const bill = await this._loadOrThrow(id, user?.businessId);
    const approvalEngine = require('./approvalEngine.service');
    if (!bill.approvalChain || bill.approvalChain.length === 0) {
      throw new ApiError(409, 'This bill has no approval chain');
    }
    if (action === 'reject') {
      approvalEngine.rejectStep(bill, user, note);
      bill.approvalStatus = APPROVAL_STATUS.REJECTED;
      return this._applyStateChange(bill, BILL_STATES.DRAFT, user, { reason: note || 'Rejected', ipAddress });
    }
    if (action === 'reassign') { approvalEngine.reassignStep(bill, level, user, note); }
    else if (action === 'escalate') { approvalEngine.escalateStep(bill, user, note); }
    else throw new ApiError(400, `Unknown approval action "${action}"`);
    bill.lastModifiedBy = user._id;
    await bill.save();
    return bill;
  }

  async approve(id, user, note, ipAddress, { override = false } = {}) {
    const bill = await this._loadOrThrow(id, user?.businessId);

    // ── M6: multi-level approval — advance the chain one step ────────────────
    const approvalEngine = require('./approvalEngine.service');
    if (Array.isArray(bill.approvalChain) && approvalEngine.currentStep(bill.approvalChain)) {
      const res = approvalEngine.approveStep(bill, user, note); // role + SoD validated
      bill.approvalLog.push({ action: 'approved', actorId: user._id, actorName: user.fullName || user.email || 'Unknown', actorRole: user.role || null, note: note || null, timestamp: new Date() });
      if (!res.fullyApproved) {
        bill.lastModifiedBy = user._id;
        await bill.save();
        return bill;
      }
    }

    // Phase 3.2 — auto-run 3-way match, then GATE on it (audit A12). A BLOCKED
    // match or a duplicate vendor invoice stops approval unless the caller passes
    // an explicit override (admin decision, recorded below). Match-engine errors
    // (e.g. the PO can't be loaded) degrade to advisory — we never block on an
    // inability to run the check, only on a check that ran and said "blocked".
    //
    // IMPORTANT: the gate runs HERE, BEFORE any approval-state mutation (approvalLog
    // push, approvalStatus set, _applyStateChange). A blocked bill without override
    // must throw while the bill is still in its prior state (e.g. 'awaiting_approval')
    // — nothing committed to the database. (Task-6 review: prior code ran the gate
    // after _applyStateChange, leaving the DB in state='approved' with no AP journal.)
    let matchOutcome = null;
    try {
      matchOutcome = await billMatchingService.runFullMatch(id, bill.businessId.toString());
    } catch (e) {
      // best-effort: a match-engine failure must not block a bill that may be fine.
      logger.warn(`[bill] 3-way match could not run on approval for ${bill.billNumber}: ${e.message}`);
    }

    if (matchOutcome) {
      const isBlocked  = matchOutcome.status === THREE_WAY_MATCH_STATUSES.BLOCKED;
      const isDuplicate = !!matchOutcome.matchResult?.duplicateCheck?.isDuplicate;
      if ((isBlocked || isDuplicate) && !override) {
        const why = matchOutcome.matchResult?.summary || 'goods/PO mismatch';
        throw new ApiError(409, `Bill cannot be approved — the goods/PO check is blocked (${why}). To approve anyway, re-submit with override enabled.`);
      }
      if ((isBlocked || isDuplicate) && override) {
        bill.approvalLog.push({
          action:    'override',
          actorId:   user._id,
          actorName: user.fullName || user.email || 'Unknown',
          actorRole: user.role || null,
          note:      `Override of ${matchOutcome.status}: ${matchOutcome.matchResult?.summary || ''}`.trim(),
          timestamp: new Date(),
        });
        await bill.save();
        try {
          await auditService.log({
            businessId:      bill.businessId,
            entityType:      ENTITY_TYPES.BILL,
            entityId:        bill._id,
            action:          'bill.match_override',
            performedBy:     user._id,
            performedByName: user.fullName || user.email || 'Unknown User',
            beforeState:     { matchStatus: matchOutcome.status },
            afterState:      { override: true, summary: matchOutcome.matchResult?.summary || null },
            ipAddress,
          });
        } catch (e) {
          // best-effort: audit-log write is observability only; the override was already recorded in approvalLog.
          logger.warn(`[bill] audit log (match_override) failed: ${e.message}`);
        }
      }
    }

    bill.approvalLog.push({
      action: 'approved',
      actorId: user._id,
      actorName: user.fullName || user.email || 'Unknown',
      actorRole: user.role || null,
      note: note || null,
      timestamp: new Date(),
    });
    bill.approvalStatus = APPROVAL_STATUS.APPROVED;
    bill.approvedBy = user._id;
    bill.approvedAt = new Date();
    await this._applyStateChange(bill, BILL_STATES.APPROVED, user, { reason: note, ipAddress });

    return this._recognizeApprovedBill(bill, user, ipAddress);
  }

  /**
   * Recognize a bill that has just landed in `approved`.
   *
   * Shared by BOTH doors into that state: the explicit approve() and
   * submitForApproval()'s below-threshold auto-promote, so the two paths can
   * never drift apart on what "approved" means to the books.
   *
   * Post the AP liability journal. Do NOT swallow a failure here — the GL must
   * reflect the liability the moment a bill is approved. The poster is atomic
   * and idempotent (guards on apLiabilityJournalId), so a surfaced error can be
   * retried safely; a silent failure would leave AP understated (audit P2).
   * @private
   */
  async _recognizeApprovedBill(bill, user, ipAddress) {
    await this.postApLiabilityJournal(bill, user, ipAddress);

    // ERP Step 4 — broadcast so dashboard / forecasting / AP-aging subscribers refresh.
    businessEvents.emit(EVENTS.BILL_APPROVED, {
      businessId: bill.businessId.toString(),
      userId:     user._id,
      entityType: ENTITY_TYPES.BILL,
      entityId:   bill._id,
      billNumber: bill.billNumber,
      vendorId:   bill.vendorId || null,
      amount:     bill.totalAmount,
    });

    return bill;
  }

  async reject(id, user, note, ipAddress) {
    const bill = await this._loadOrThrow(id, user?.businessId);
    bill.approvalLog.push({
      action: 'rejected',
      actorId: user._id,
      actorName: user.fullName || user.email || 'Unknown',
      actorRole: user.role || null,
      note: note || null,
      timestamp: new Date(),
    });
    bill.approvalStatus = APPROVAL_STATUS.REJECTED;
    return this._applyStateChange(bill, BILL_STATES.DRAFT, user, {
      reason: note || 'Rejected — returned to draft',
      ipAddress,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle ops
  // ───────────────────────────────────────────────────────────────────────────

  async schedule(id, user, payDate, ipAddress) {
    const bill = await this._loadOrThrow(id, user?.businessId);
    bill.scheduledPayDate = payDate || null;
    return this._applyStateChange(bill, BILL_STATES.SCHEDULED, user, {
      reason: payDate ? `Scheduled for ${new Date(payDate).toISOString()}` : null,
      ipAddress,
    });
  }

  async cancel(id, user, reason, ipAddress) {
    const bill = await this._loadOrThrow(id, user?.businessId);
    // A recognized bill-first bill IS in the books (expense + AP posted, vendor
    // balance moved). Cancelling would close the document while the books keep
    // holding the liability — the document-side open-items view and the vendor
    // balance would disagree forever (spec 2026-07-16). Void is the honest
    // exit: it reverses the accounting and closes the document together.
    if (bill.apLiabilityJournalId) {
      throw new ApiError(
        400,
        `${bill.billNumber} is already recorded in your books, so it can't be cancelled. `
        + 'Void it instead — voiding reverses the accounting and closes the bill together.'
      );
    }
    return this._applyStateChange(bill, BILL_STATES.CANCELLED, user, { reason, ipAddress });
  }

  /** M5 — GL-correct void (reverses recognition + reclaims payments; never deletes). */
  async void(id, reason, user, ipAddress) {
    const bill = await this._loadOrThrow(id, user?.businessId);
    const arApVoidCredit = require('./arApVoidCredit.service');
    return arApVoidCredit.voidDocument('bill', bill, reason, user, ipAddress);
  }

  /** M5 — apply a vendor credit memo (DR AP / CR Expense) to this bill. */
  async applyCreditMemo(id, amount, reason, user, ipAddress) {
    const bill = await this._loadOrThrow(id, user?.businessId);
    const arApVoidCredit = require('./arApVoidCredit.service');
    return arApVoidCredit.applyCreditMemo('bill', bill, amount, reason, user, ipAddress);
  }

  /** M8 — preview the early-payment discount currently available on this bill. */
  async previewEarlyPaymentDiscount(id, businessId = null) {
    const bill = await this._loadOrThrow(id, businessId);
    return require('./earlyPaymentDiscount.service').preview('bill', bill);
  }

  /** M8 — realize the early-payment discount taken (DR AP / CR Discount Received). */
  async applyEarlyPaymentDiscount(id, user, ipAddress) {
    const bill = await this._loadOrThrow(id, user?.businessId);
    return require('./earlyPaymentDiscount.service').apply('bill', bill, user, ipAddress, {});
  }

  /**
   * Phase 2 — update a draft bill (only drafts can be edited).
   */
  async updateDraft(id, data, user, ipAddress) {
    const bill = await this._loadOrThrow(id, user?.businessId);
    if (bill.state !== BILL_STATES.DRAFT) {
      throw new ApiError(409, 'Only draft bills can be edited');
    }

    // ── M4 enterprise validation (service layer) ─────────────────────────────
    validateDocumentData(
      { ...data, issueDate: data.issueDate || bill.issueDate },
      { kind: 'bill', isUpdate: true }
    );
    if (data.billNumber && data.billNumber !== bill.billNumber) {
      await assertNoDuplicateNumber(Bill, bill.businessId, data.billNumber, 'billNumber', bill._id);
    }
    if (data.vendorId) {
      await assertPartyExists(vendorRepository, bill.businessId, data.vendorId, 'Vendor');
    }
    const editable = [
      'billNumber', 'vendorReferenceNumber', 'vendorId', 'lineItems', 'amount', 'taxAmount',
      'whtAmount', 'currencyCode', 'invoiceDiscountType', 'invoiceDiscountValue',
      'shippingCharges', 'roundingAdjustment', 'issueDate', 'dueDate',
      'description', 'notes', 'tags', 'attachments',
    ];
    for (const field of editable) {
      if (data[field] !== undefined) {
        const before = bill[field];
        bill[field] = data[field];
        if (!['lineItems', 'attachments', 'tags'].includes(field)) {
          bill.recordFieldChange(field, before, data[field], user._id);
        }
      }
    }
    if (data.vendorId && String(data.vendorId) !== String(bill.vendorId)) {
      bill.vendorSnapshot = await this._vendorSnapshot(bill.businessId, data.vendorId);
    }
    const hasLines = bill.lineItems && bill.lineItems.length > 0;
    const estimateAmount = hasLines
      ? bill.lineItems.reduce((s, li) => s + (li.quantity || 0) * (li.unitPrice || 0), 0)
      : bill.amount;
    bill.approvalRequired = this._requiresApproval(estimateAmount, data.businessConfig);
    bill.approvalStatus = bill.approvalRequired ? APPROVAL_STATUS.PENDING : APPROVAL_STATUS.NOT_REQUIRED;
    bill.lastModifiedBy = user._id;
    await bill.save();
    try {
      await auditService.log({
        businessId:      bill.businessId,
        entityType:      ENTITY_TYPES.BILL,
        entityId:        bill._id,
        action:          AUDIT_ACTIONS.EDITED,
        performedBy:     user._id,
        performedByName: user.fullName || user.email || 'Unknown',
        ipAddress,
      });
    } catch (e) {
      // best-effort: audit-log write is observability only; the draft update was already saved.
      logger.warn(`[bill] audit log (updateDraft) failed: ${e.message}`);
    }
    return bill;
  }

  async markPaid(id, user, ipAddress, opts = {}) {
    const bill = await this._loadOrThrow(id, user?.businessId);

    // ── ONE settlement engine (spec 2026-07-16, I-4/I-5) ─────────────────────
    // markPaid IS a payment: the full remaining balance, recorded through
    // payment.service like every other payment. That gives every markPaid a
    // real Payment document (audit), posts the settlement journal, moves the
    // vendor balance in BASE currency (the old path decremented document
    // units — an F2-class bug on foreign bills), and settles whichever side
    // owns the open item (document for bill-first, JE for transaction-first —
    // the old transaction-first path flipped the document while the ledger
    // kept the full liability open).
    const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
    let item = null;
    try {
      item = await require('./openItem.service')
        .resolveOpenItem(bill.businessId, { documentType: 'bill', documentId: bill._id });
    } catch (e) {
      item = null; // no posted journal behind it — nothing to settle, plain flip below
    }

    let paid;
    if (item && item.remainingBase > 0) {
      // Payments leave in DOCUMENT currency; the resolver's balance is base.
      const outstandingDoc = item.authority === 'document' && item.doc.remainingBalance != null
        ? r2(item.doc.remainingBalance)
        : r2(item.remainingBase / item.bookingRate);
      const cashAccountId = opts.paymentAccountId
        || (await accountResolver.resolve(bill.businessId, '1010'))._id;

      await require('./payment.service').recordPayment(bill.businessId, {
        amount: outstandingDoc,
        cashAccountId,
        paymentDate: new Date(),
        reference: `markpaid:${bill._id}`,
        notes: `Marked paid — ${bill.billNumber}`,
        allocations: [{ documentType: 'bill', documentId: bill._id, amount: outstandingDoc }],
      }, user._id, ipAddress);

      // Journal-authority items flip the document through the M1 reconciler —
      // run it now (idempotent) so the document we return already shows its
      // final state instead of waiting on the event subscriber.
      if (item.authority === 'journal') {
        await require('./arApReconciliation.service')
          .reconcileByJournalEntryId(bill.businessId, item.je._id);
      }
      paid = await this._loadOrThrow(id, user?.businessId);
    } else {
      // Nothing settleable (no journal, or nothing outstanding) — the
      // historical plain state flip.
      bill.paidAmount = bill.totalAmount;
      bill.remainingBalance = 0;
      paid = await this._applyStateChange(bill, BILL_STATES.PAID, user, { ipAddress });
    }

    // Broadcast regardless so downstream caches refresh on any payment path.
    businessEvents.emit(EVENTS.BILL_PAID, {
      businessId: bill.businessId.toString(),
      userId:     user._id,
      entityType: ENTITY_TYPES.BILL,
      entityId:   bill._id,
      billNumber: bill.billNumber,
      vendorId:   bill.vendorId || null,
      amount:     bill.totalAmount,
    });

    return paid;
  }

  /**
   * (The old _postBillSettlementJournal helper lived here. markPaid now
   * records a real Payment through payment.service — ONE settlement engine —
   * so the bespoke settlement poster was deleted rather than left as a trap.)
   */

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 3.2 — 3-Way Match
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Run the 3-way match engine for a bill and persist the result.
   * Safe to call multiple times (idempotent — updates matchResult in-place).
   *
   * @param {string} id          — Bill _id
   * @param {string} businessId
   * @param {Object} toleranceCfg — optional tolerance overrides
   * @returns {Promise<{ status, matchResult, bill }>}
   */
  async runMatch(id, businessId, toleranceCfg = {}) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid bill id');
    return billMatchingService.runFullMatch(id, businessId, toleranceCfg);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 3.2 — AP Liability Journal
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Post the Accounts-Payable liability journal entry when a bill is approved.
   *
   * Accounting entry:
   *   DR  Purchases / Inventory / Expense  (primary expense account from line items)
   *   CR  Accounts Payable                 (code 2110)
   *
   * If the bill has a taxAmount, a second entry is created:
   *   DR  Input Tax Receivable             (code 1170 — created by tax engine if enabled)
   *   CR  Accounts Payable
   *
   * Both entries are tagged transactionSource:'system_generated' so they
   * appear separately from manual journals in the audit trail. Posting goes
   * through ledgerPosting.postBalancedJournal so the Chart-of-Accounts running
   * balances move in lock-step (GAAP trial-balance integrity).
   *
   * ERP Step 4: after the AP control account is credited, the vendor's
   * currentPayableBalance is incremented by the SAME amount through
   * partyBalanceService — keeping "AP control == Σ vendor balances" — and a
   * BILL_APPROVED-adjacent VENDOR_BALANCE_CHANGED event is broadcast.
   *
   * @param {Object} bill       — Mongoose Bill document (already saved, approved state)
   * @param {Object} user
   * @param {string} ipAddress
   * @returns {Promise<Object|null>}  The primary JournalEntry, or null if skipped
   */
  // Exposed as a method so unit tests can stub it (same pattern as goodsReceipt).
  // Resolves a default account by code, back-filling it (additive, idempotent) if a
  // business predates it — so the GRNI clearing works on every business out of the box.
  async _ensureAccount(businessId, code) {
    let acc = await accountRepo.findByCode(businessId, code);
    if (!acc) {
      if (typeof accountRepo.syncMissingDefaults === 'function') await accountRepo.syncMissingDefaults(businessId);
      acc = await accountRepo.findByCode(businessId, code);
    }
    return acc;
  }

  // A13 — Σ posted GRNI accrual value of the GRNs feeding this bill (capped by caller).
  // Bills link to their PO via `purchaseOrderId`; the GRNs that posted a GRNI accrual
  // are those confirmed receipts against that PO carrying a `glJournalId`. We recompute
  // the accrual from acceptedQty×unitCost on stocked lines (matches what the GRN posted
  // in goodsReceipt.service). Returns 0 when there is no confirmed-GRN linkage
  // (degrades to expense-only — back-compat with ad-hoc bills).
  async _linkedGrniValue(bill) {
    if (!bill.purchaseOrderId) return 0;
    const GoodsReceipt = require('../models/GoodsReceipt.model');
    const grns = await GoodsReceipt.find({
      businessId: bill.businessId, purchaseOrderId: bill.purchaseOrderId, glJournalId: { $ne: null },
    }).lean();
    let total = 0;
    for (const grn of (grns || [])) {
      for (const ri of (grn.receivedItems || [])) {
        if (!ri.inventoryItemId) continue;
        const acceptedQty = Math.max(0, Number(ri.quantityReceived || 0) - Number(ri.quantityRejected || 0));
        total += acceptedQty * (Number(ri.unitCost) || 0);
      }
    }
    return Math.round(total * 100) / 100;
  }

  async postApLiabilityJournal(bill, user, ipAddress) {
    // Skip if a JE was already created (idempotent guard)
    if (bill.apLiabilityJournalId || bill.linkedJournalEntryId) {
      logger.debug(`[bill] skipping AP journal for ${bill.billNumber} — JE already exists`);
      return null;
    }

    const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
    const businessId = bill.businessId;

    // ── Accounts Payable (2110) ──────────────────────────────────────────────
    // Resolved, never skipped. This used to warn and `return null` when 2110 was
    // absent, so the bill became approved while the payable was silently never
    // recognised — the AP mirror of the invoice fail-open. 2110 is a default, so
    // the resolver seeds it rather than failing.
    const apAccount = await accountResolver.resolve(businessId, '2110');

    // Expense/inventory debit account (line account → Purchases 5100).
    let expenseAccountId = null;
    if (bill.lineItems && bill.lineItems.length > 0) {
      const firstWithAccount = bill.lineItems.find((li) => li.accountId);
      if (firstWithAccount) expenseAccountId = firstWithAccount.accountId;
    }
    if (!expenseAccountId) {
      // Falls back to Miscellaneous Expenses (6390).
      //
      // The old fallback asked for 5100 → 5000 → 6100, and NONE of those exist in
      // DEFAULT_ACCOUNTS — so for any standard business the chain always resolved
      // to null, warned, and skipped the AP journal entirely. It stayed hidden
      // only because bill lines normally carry an explicit account.
      //
      // 6390 is the honest answer to "an expense whose category we were not told":
      // it says we do not know, rather than guessing a category and being
      // confidently wrong, and the owner can recategorise it. Booking the payable
      // to Miscellaneous is strictly better than not booking it at all.
      expenseAccountId = await accountResolver.resolveId(businessId, '6390');
    }

    // F2 (residual) — the ledger is BASE currency; the bill keeps its foreign
    // face amounts. Convert at the bill's booking rate before building lines,
    // so the GRNI comparison (GRNI accruals are posted in base) is also
    // base-to-base instead of base-to-foreign.
    const bookingRate = Number(bill.exchangeRate) > 0 ? Number(bill.exchangeRate) : 1;
    const taxAmount = toBaseAmount(bill.taxAmount || 0, bookingRate);
    const netAmount = r2(bill.amount || (bill.totalAmount - (bill.taxAmount || 0)));
    const billNet = toBaseAmount(netAmount > 0 ? netAmount : r2(bill.totalAmount - (bill.taxAmount || 0)), bookingRate);

    // Stocked-line subtotal (lines that hit inventory) bounds how much GRNI we can clear.
    const stockedSubtotal = toBaseAmount((bill.lineItems || [])
      .filter((li) => li.inventoryItemId)
      .reduce((s, li) => s + Number(li.quantity || 0) * Number(li.unitPrice || 0), 0), bookingRate);

    const linkedGrni = r2(await this._linkedGrniValue(bill));
    const grniDebit = r2(Math.min(linkedGrni, stockedSubtotal));
    const expenseDebit = r2(billNet - grniDebit);

    // Build the compound lines.
    const lines = [];
    if (grniDebit > 0) {
      const grniAcc = await this._ensureAccount(businessId, '2115');
      if (!grniAcc) throw new ApiError(400, `Cannot post ${bill.billNumber}: GRNI (2115) account missing.`);
      lines.push({ accountId: grniAcc._id, type: 'debit', amount: grniDebit, description: 'Clear goods received not invoiced' });
    }
    if (expenseDebit > 0.0001) {
      // No `if (!expenseAccountId) return null` guard: the resolver above either
      // returns an account or throws, so this can no longer be unset. Skipping
      // here was the fail-open — it dropped the whole payable on the floor.
      lines.push({ accountId: expenseAccountId, type: 'debit', amount: expenseDebit, description: 'Purchase / expense' });
    }
    if (taxAmount > 0) {
      const inputTaxAcc = await ChartOfAccount.findOne({ businessId, accountCode: { $in: ['1170', '1171', '1172'] } }).lean();
      if (inputTaxAcc) lines.push({ accountId: inputTaxAcc._id, type: 'debit', amount: taxAmount, description: 'Recoverable input tax' });
    }
    const apCredit = r2(lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amount, 0));
    lines.push({ accountId: apAccount._id, type: 'credit', amount: apCredit, description: 'Accounts payable' });

    // ── R-01: recognize AP atomically ────────────────────────────────────────
    // The single compound JE, the bill document update and the vendor balance move
    // commit together or roll back together (standalone dev falls back to non-atomic).
    // A failure rolls everything back, so a bill is never half-recognized (e.g. AP
    // posted but the vendor balance missing). The compound poster rejects an
    // unbalanced entry — keep that as the balance guard.
    let primaryJe = null;
    const preLinked = bill.linkedJournalEntryId; // remember to restore on rollback
    try {
      await withTransaction(async (session) => {
        primaryJe = await postCompoundJournal({
          businessId,
          transactionDate:   bill.issueDate,
          description:       `AP Liability — ${bill.billNumber}${bill.vendorSnapshot?.vendorName ? ' (' + bill.vendorSnapshot.vendorName + ')' : ''}`,
          // One payable per bill, forever — a retry must not owe twice.
          idempotencyKey: `bill-ap:${bill._id}`,
          transactionType:   TRANSACTION_TYPES.CREDIT_PURCHASE,
          transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
          invoiceNumber:     bill.billNumber,
          vendorId:          bill.vendorId || null,
          currencyCode:      bill.currencyCode || 'PKR',
          exchangeRate:      bookingRate,
          baseCurrencyAmount: apCredit,            // pinned (F2): lines are already base
          createdBy:         user._id,
          lastModifiedBy:    user._id,
          taxAmount:         taxAmount || 0,
          // M9 — this entry is the immutable projection of the authoritative bill.
          isProjection:      true,
          projectionOf:      { documentType: 'bill', documentId: bill._id },
          idempotencyKey:    `bill:ap:${bill._id}`,
          lines,
        }, { session });

        bill.apLiabilityJournalId = primaryJe._id;
        if (!bill.linkedJournalEntryId) bill.linkedJournalEntryId = primaryJe._id;
        await bill.save({ session });

        // Mirror the AP credit onto the vendor's payable balance (broadcasts
        // VENDOR_BALANCE_CHANGED). Joined to the same transaction.
        if (bill.vendorId && apCredit > 0) {
          await partyBalanceService.adjustPayable(businessId, bill.vendorId, apCredit, {
            userId: user._id, reason: 'bill_approved', entityType: ENTITY_TYPES.BILL, entityId: bill._id, session,
          });
        }
      });
    } catch (e) {
      // The GL writes already rolled back atomically (inner withTransaction).
      // Restore the in-memory link fields and RE-THROW — never swallow: a bill must
      // not be reported as approved while its AP liability silently failed to post
      // (audit P2). The guard fields are reset so a retry re-posts cleanly.
      bill.apLiabilityJournalId = undefined;
      bill.linkedJournalEntryId = preLinked;
      logger.error(`[bill] AP recognition rolled back for ${bill.billNumber}: ${e.message}`);
      throw e;
    }

    return primaryJe;
  }

  async transitionState(id, toState, user, { reason = null, ipAddress = null } = {}) {
    // Money-bearing exits route through their proper flows — a raw state flip
    // must never stand in for a settlement or a reversal (spec 2026-07-16 I-4).
    if (toState === BILL_STATES.PAID) return this.markPaid(id, user, ipAddress);
    if (toState === BILL_STATES.CANCELLED) return this.cancel(id, user, reason, ipAddress);
    if (toState === BILL_STATES.VOIDED) return this.void(id, reason, user, ipAddress);
    if (toState === BILL_STATES.PARTIALLY_PAID) {
      throw new ApiError(
        400,
        'A bill becomes partially paid by recording a payment against it — record the payment instead.'
      );
    }
    const bill = await this._loadOrThrow(id, user?.businessId);
    return this._applyStateChange(bill, toState, user, { reason, ipAddress });
  }

  async softDelete(id, user, ipAddress) {
    const bill = await this._loadOrThrow(id, user?.businessId);
    if (bill.isArchived) return bill;
    bill.isArchived = true;
    bill.archivedAt = new Date();
    bill.archivedBy = user._id;
    bill.lastModifiedBy = user._id;
    await bill.save();
    try {
      await auditService.logDelete(
        ENTITY_TYPES.BILL,
        bill._id,
        bill.businessId,
        user._id,
        bill.toObject(),
        ipAddress
      );
    } catch (e) {
      // best-effort: audit-log write is observability only; the soft-delete was already committed.
      logger.warn(`[bill] audit logDelete failed: ${e.message}`);
    }
    return bill;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Sync helper (dual-write from transaction.service)
  // ───────────────────────────────────────────────────────────────────────────

  async syncFromJournalEntry(je, user, ipAddress) {
    if (!je || !je.invoiceNumber) return null;
    const existing = await Bill.findOne({
      businessId: je.businessId,
      billNumber: je.invoiceNumber, // we reuse the BILL-XXXXX number stored on JE.invoiceNumber
    });
    if (existing) {
      if (!existing.linkedJournalEntryId) {
        existing.linkedJournalEntryId = je._id;
        await existing.save();
      }
      return existing;
    }
    const snap = await this._vendorSnapshot(je.businessId, je.vendorId);
    let initialState = BILL_STATES.APPROVED; // ledger posted ⇒ approved
    if (je.paymentStatus === 'paid')                initialState = BILL_STATES.PAID;
    else if (je.paymentStatus === 'partially_paid') initialState = BILL_STATES.PARTIALLY_PAID;
    else if (je.paymentStatus === 'overdue')        initialState = BILL_STATES.OVERDUE;

    const totalAmount = (je.amount || 0) + (je.taxAmount || 0);
    const approvalRequired = this._requiresApproval(totalAmount);

    const bill = new Bill({
      businessId:           je.businessId,
      billNumber:           je.invoiceNumber,
      linkedJournalEntryId: je._id,
      vendorId:             je.vendorId || null,
      vendorSnapshot:       snap,
      amount:               je.amount,
      taxAmount:            je.taxAmount || 0,
      currencyCode:         je.currencyCode || 'PKR',
      issueDate:            je.transactionDate,
      dueDate:              je.dueDate || null,
      state:                initialState,
      paidAmount:           je.partiallyPaidAmount || 0,
      remainingBalance:     je.remainingBalance != null ? je.remainingBalance : totalAmount,
      approvalRequired,
      approvalStatus:       approvalRequired ? APPROVAL_STATUS.APPROVED : APPROVAL_STATUS.NOT_REQUIRED,
      approvalThreshold:    approvalRequired ? DEFAULT_APPROVAL_THRESHOLD : null,
      approvedBy:           approvalRequired ? user._id : null,
      approvedAt:           approvalRequired ? new Date() : null,
      description:          je.description || null,
      createdBy:            user._id,
      lastModifiedBy:       user._id,
    });
    bill.recordStateChange(initialState, user, 'Auto-created from journal entry');
    if (approvalRequired) {
      bill.approvalLog.push({
        action:    'approved',
        actorId:   user._id,
        actorName: user.fullName || user.email || 'System',
        note:      'Auto-approved (created via direct journal posting)',
        timestamp: new Date(),
      });
    }
    await bill.save();
    try {
      await auditService.logCreate(
        ENTITY_TYPES.BILL,
        bill._id,
        bill.businessId,
        user._id,
        bill.toObject(),
        ipAddress
      );
    } catch (e) {
      // best-effort: audit-log write is observability only; the synced bill was already persisted.
      logger.warn(`[bill] audit logCreate (sync) failed: ${e.message}`);
    }
    return bill;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Read APIs
  // ───────────────────────────────────────────────────────────────────────────

  async _loadOrThrow(id, businessId = null) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, 'Invalid bill id');
    }
    // R-05: scope by tenant when provided so cross-tenant ids can't be loaded.
    const bill = businessId
      ? await Bill.findOne({ _id: id, businessId })
      : await Bill.findById(id);
    if (!bill) throw new ApiError(404, 'Bill not found');
    if (bill.isArchived) throw new ApiError(410, 'Bill has been archived');
    return bill;
  }

  async getById(id, businessId) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, 'Invalid bill id');
    }
    const query = { _id: id };
    if (businessId) query.businessId = businessId;
    const bill = await Bill.findOne(query);
    if (!bill) throw new ApiError(404, 'Bill not found');
    return bill;
  }

  async list(businessId, filters = {}, pagination = {}) {
    const { page = 1, limit = 25 } = pagination;
    const q = { businessId, isArchived: { $ne: true } };
    if (filters.state) q.state = filters.state;
    if (filters.vendorId) q.vendorId = filters.vendorId;
    if (filters.approvalStatus) q.approvalStatus = filters.approvalStatus;
    if (filters.search) q.billNumber = { $regex: filters.search, $options: 'i' };
    if (filters.startDate || filters.endDate) {
      q.issueDate = {};
      if (filters.startDate) q.issueDate.$gte = new Date(filters.startDate);
      if (filters.endDate)   q.issueDate.$lte = new Date(filters.endDate);
    }
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      Bill.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Bill.countDocuments(q),
    ]);
    return { data, total, page, limit };
  }

  async getTimeline(id, businessId) {
    const bill = await this.getById(id, businessId);
    const entries = [];
    for (const e of (bill.approvalLog || [])) {
      entries.push({ type: 'approval', timestamp: e.timestamp, ...e.toObject?.() ?? e });
    }
    for (const e of (bill.stateHistory || [])) {
      entries.push({ type: 'state', timestamp: e.timestamp, ...e.toObject?.() ?? e });
    }
    for (const e of (bill.fieldHistory || [])) {
      entries.push({ type: 'field', timestamp: e.changedAt, ...e.toObject?.() ?? e });
    }
    entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return { bill, timeline: entries };
  }
}

module.exports = new BillService();

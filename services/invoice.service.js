// services/invoice.service.js
//
// Phase 1 — Invoice domain service.
//
// Owns the Invoice lifecycle (state machine, approval workflow, audit trail).
// Delegates ledger posting to transaction.service so JournalEntry remains the
// GAAP source of truth.
//
// Public API:
//   createDraft(data, user, ip)        → Invoice (state=draft, no ledger entry)
//   submitForApproval(id, user, ip)    → Invoice (state=pending_approval)
//   approve(id, user, note, ip)        → Invoice (state=approved, ledger posted)
//   reject(id, user, note, ip)         → Invoice (state=rejected/back-to-draft)
//   send(id, user, ip)                 → Invoice (state=sent)
//   markPaid(id, user, ip)             → Invoice (state=paid)  [internal use mostly]
//   cancel(id, user, reason, ip)       → Invoice (state=cancelled, ledger reversed if posted)
//   dispute(id, user, reason, ip)      → Invoice (state=disputed)
//   writeOff(id, user, reason, ip)     → Invoice (state=written_off)
//   softDelete(id, user, ip)           → Invoice (isArchived=true)
//   transitionState(id, toState, user, opts)  → low-level guard wrapper
//   getById(id, businessId)            → Invoice
//   list(businessId, filters, page)    → { data, total }
//   syncFromJournalEntry(je, user)     → Invoice (idempotent — used by transaction.service)
//

const mongoose = require('mongoose');
const Invoice = require('../models/Invoice.model');
const ChartOfAccount = require('../models/ChartOfAccount.model');
const customerRepository = require('../repositories/customer.repository');
const auditService = require('./audit.service');
const fxService = require('./fx.service');
const partyBalanceService = require('./partyBalance.service');     // ERP Step 4 — centralized AR balance
const { postBalancedJournal } = require('./ledgerPosting.service'); // ERP Step 4 — JE + running-balance sync
const { withTransaction } = require('../utils/withTransaction');   // R-01 — atomic recognition unit
const { businessEvents, EVENTS } = require('./businessEventEngine.service'); // ERP Step 4 — event broadcasts
const { ApiError } = require('../utils/ApiError');
const { validateDocumentData, assertNoDuplicateNumber, assertPartyExists } = require('../utils/arApValidation'); // M4
const paymentTermsUtil = require('../utils/paymentTerms'); // M8 — structured payment terms
const logger = require('../config/logger');
const {
  INVOICE_STATES,
  APPROVAL_STATUS,
  AUDIT_ACTIONS,
  ENTITY_TYPES,
  DEFAULT_APPROVAL_THRESHOLD,
  TRANSACTION_TYPES,
  TRANSACTION_SOURCES,
  JOURNAL_STATUS,
} = require('../config/constants');

class InvoiceService {
  // ───────────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────────

  /** Determine whether this invoice amount requires approval. */
  _requiresApproval(amount, businessConfig = {}) {
    const threshold = Number.isFinite(businessConfig.invoiceApprovalThreshold)
      ? businessConfig.invoiceApprovalThreshold
      : DEFAULT_APPROVAL_THRESHOLD;
    return amount >= threshold;
  }

  /** Snapshot customer details so renames don't rewrite historic invoices. */
  async _customerSnapshot(businessId, customerId) {
    if (!customerId) return {};
    const c = await customerRepository.findByBusinessAndId(businessId, customerId);
    if (!c) return {};
    return {
      fullName:     c.fullName || null,
      businessName: c.businessName || null,
      email:        c.email || null,
      phone:        c.phone || null,
      taxId:        c.taxId || null,
    };
  }

  /** Guard + apply a state transition; throws ApiError if illegal. */
  _guardTransition(invoice, toState) {
    if (!Invoice.canTransition(invoice.state, toState)) {
      throw new ApiError(
        409,
        `Illegal state transition: invoice ${invoice._id} cannot move from "${invoice.state}" to "${toState}"`
      );
    }
  }

  /** Centralised state-change applier that records history + emits audit. */
  async _applyStateChange(invoice, toState, user, { reason = null, ipAddress = null, session = null } = {}) {
    this._guardTransition(invoice, toState);
    const fromState = invoice.state;
    invoice.recordStateChange(toState, user, reason);
    invoice.state = toState;
    invoice.lastModifiedBy = user._id;
    await invoice.save({ session });

    // Emit audit log (best-effort — never block state change on audit failure)
    try {
      await auditService.log({
        businessId:      invoice.businessId,
        entityType:      ENTITY_TYPES.INVOICE,
        entityId:        invoice._id,
        action:          AUDIT_ACTIONS.STATE_CHANGED,
        performedBy:     user._id,
        performedByName: user.fullName || user.email || 'Unknown User',
        beforeState:     { state: fromState },
        afterState:      { state: toState, reason },
        ipAddress,
      });
    } catch (e) {
      logger.warn(`[invoice] audit log failed for state change ${fromState}→${toState}: ${e.message}`);
    }
    return invoice;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Creation
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Create a draft invoice — no ledger posting yet.
   * Phase 2: Accepts lineItems, discount, shipping, multi-currency, attachments, bank details.
   * If lineItems are provided, amount is auto-computed by the model's pre-save hook.
   */
  /**
   * Auto-generate a unique invoice number for a business.
   * Format: INV-YYYYMM-NNNNN (sequential within the calendar month).
   * @private
   */
  async _generateInvoiceNumber(businessId) {
    const now = new Date();
    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const last = await Invoice.findOne({
      businessId,
      invoiceNumber: { $regex: `^INV-${yyyymm}-` },
    }).sort({ createdAt: -1 }).select('invoiceNumber').lean();

    let seq = 1;
    if (last?.invoiceNumber) {
      const n = parseInt(last.invoiceNumber.split('-').pop(), 10);
      if (!isNaN(n)) seq = n + 1;
    }
    return `INV-${yyyymm}-${String(seq).padStart(5, '0')}`;
  }

  async createDraft(data, user, ipAddress) {
    const hasLines = Array.isArray(data.lineItems) && data.lineItems.length > 0;

    // Auto-generate invoice number if the caller omitted it
    if (!data.invoiceNumber?.trim()) {
      data.invoiceNumber = await this._generateInvoiceNumber(data.businessId);
    }

    // ── M4 enterprise validation (service layer) ─────────────────────────────
    validateDocumentData(data, { kind: 'invoice', isUpdate: false });
    await assertNoDuplicateNumber(Invoice, data.businessId, data.invoiceNumber, 'invoiceNumber');
    await assertPartyExists(customerRepository, data.businessId, data.customerId, 'Customer');

    const snap = await this._customerSnapshot(data.businessId, data.customerId);

    // ── M8 — structured payment terms drive dueDate + discount window ─────────
    // Backward-compatible: only engages when paymentTermsCode/paymentTerms is
    // supplied; an explicit data.dueDate always wins over the derived one.
    let termsSnapshot;
    let derivedDueDate = data.dueDate || null;
    if (data.paymentTermsCode || data.paymentTerms) {
      termsSnapshot = paymentTermsUtil.buildSnapshot(data.paymentTermsCode || data.paymentTerms);
      termsSnapshot.discountDeadline = paymentTermsUtil.computeDiscountDeadline(data.issueDate, termsSnapshot);
      if (!derivedDueDate) derivedDueDate = paymentTermsUtil.computeDueDate(data.issueDate, termsSnapshot);
    }

    // Multi-currency: resolve FX rate if foreign currency
    let fxFields = {};
    const txnCurrency = (data.currencyCode || 'PKR').toUpperCase();
    try {
      fxFields = await fxService.prepareFxFields(
        data.amount || 0, txnCurrency, data.businessId, data.issueDate
      );
    } catch (e) {
      logger.warn(`[invoice] FX prepareFxFields failed (non-fatal): ${e.message}`);
      fxFields = { currencyCode: txnCurrency, exchangeRate: 1, baseCurrencyAmount: data.amount || 0 };
    }

    // Amount for threshold check: use provided amount or estimate from lineItems
    const estimateAmount = data.amount || (hasLines
      ? data.lineItems.reduce((s, li) => s + (li.quantity || 0) * (li.unitPrice || 0), 0)
      : 0);
    const approvalRequired = this._requiresApproval(estimateAmount, data.businessConfig);

    const invoice = new Invoice({
      businessId:        data.businessId,
      invoiceNumber:     data.invoiceNumber,
      linkedJournalEntryId: data.linkedJournalEntryId || null,
      customerId:        data.customerId || null,
      customerSnapshot:  Object.keys(snap).length ? snap : data.customerSnapshot || {},

      // Line items (Phase 2)
      lineItems:         hasLines ? data.lineItems : [],

      // Money — if lineItems present, pre-save hook computes amount/taxAmount/totalAmount
      amount:            hasLines ? 0.01 : data.amount, // placeholder; pre-save overrides when lineItems exist
      taxAmount:         data.taxAmount || 0,
      currencyCode:      fxFields.currencyCode || txnCurrency,

      // Dynamic totals (Phase 2)
      invoiceDiscountType:  data.invoiceDiscountType || null,
      invoiceDiscountValue: data.invoiceDiscountValue || 0,
      shippingCharges:      data.shippingCharges || 0,
      roundingAdjustment:   data.roundingAdjustment || 0,

      // Multi-currency (Phase 2)
      baseCurrencyCode:  fxFields.currencyCode === (await fxService.getBaseCurrency(data.businessId))
        ? fxFields.currencyCode : await fxService.getBaseCurrency(data.businessId),
      exchangeRate:      fxFields.exchangeRate || 1,

      // Template & bank details (Phase 2)
      templateId:        data.templateId || 'modern',
      bankDetails:       data.bankDetails || {},
      paymentTermsText:  data.paymentTermsText || null,

      // Attachments (Phase 2)
      attachments:       data.attachments || [],

      issueDate:         data.issueDate,
      dueDate:           derivedDueDate,
      paymentTerms:      termsSnapshot || undefined,
      isRecurring:       data.isRecurring || false,
      recurringScheduleId: data.recurringScheduleId || null,
      state:             INVOICE_STATES.DRAFT,
      approvalRequired,
      approvalStatus:    approvalRequired ? APPROVAL_STATUS.PENDING : APPROVAL_STATUS.NOT_REQUIRED,
      approvalThreshold: approvalRequired ? (data.businessConfig?.invoiceApprovalThreshold ?? DEFAULT_APPROVAL_THRESHOLD) : null,
      description:       data.description || null,
      notes:             data.notes || null,
      tags:              data.tags || [],
      createdBy:         user._id,
      lastModifiedBy:    user._id,
    });

    invoice.recordStateChange(INVOICE_STATES.DRAFT, user, 'Initial creation');
    await invoice.save(); // pre-save hook computes lineItem totals

    try {
      await auditService.logCreate(
        ENTITY_TYPES.INVOICE,
        invoice._id,
        invoice.businessId,
        user._id,
        invoice.toObject(),
        ipAddress
      );
    } catch (e) {
      logger.warn(`[invoice] audit logCreate failed: ${e.message}`);
    }
    return invoice;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 2: Update draft
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Update a draft invoice (only drafts can be edited).
   * Accepts full lineItems replacement, discount, shipping, bank details, etc.
   * Records field-level changes in fieldHistory.
   */
  async updateDraft(id, data, user, ipAddress) {
    const invoice = await this._loadOrThrow(id, user?.businessId);
    if (invoice.state !== INVOICE_STATES.DRAFT) {
      throw new ApiError(409, 'Only draft invoices can be edited');
    }

    // ── M4 enterprise validation (service layer) ─────────────────────────────
    // Cross-field rules respect the document's own dates when not being changed.
    validateDocumentData(
      { ...data, issueDate: data.issueDate || invoice.issueDate },
      { kind: 'invoice', isUpdate: true }
    );
    if (data.invoiceNumber && data.invoiceNumber !== invoice.invoiceNumber) {
      await assertNoDuplicateNumber(Invoice, invoice.businessId, data.invoiceNumber, 'invoiceNumber', invoice._id);
    }
    if (data.customerId) {
      await assertPartyExists(customerRepository, invoice.businessId, data.customerId, 'Customer');
    }

    // Editable fields whitelist
    const editable = [
      'invoiceNumber', 'customerId', 'lineItems', 'amount', 'taxAmount',
      'currencyCode', 'invoiceDiscountType', 'invoiceDiscountValue',
      'shippingCharges', 'roundingAdjustment', 'issueDate', 'dueDate',
      'description', 'notes', 'tags', 'templateId', 'bankDetails',
      'paymentTermsText', 'attachments',
    ];

    for (const field of editable) {
      if (data[field] !== undefined) {
        const before = invoice[field];
        invoice[field] = data[field];
        // Record scalar field changes (skip large arrays from fieldHistory for perf)
        if (!['lineItems', 'attachments', 'tags', 'bankDetails'].includes(field)) {
          invoice.recordFieldChange(field, before, data[field], user._id);
        }
      }
    }

    // Re-snapshot customer if customerId changed
    if (data.customerId && String(data.customerId) !== String(invoice.customerId)) {
      invoice.customerSnapshot = await this._customerSnapshot(invoice.businessId, data.customerId);
    }

    // Recalculate approval requirement based on new amount estimate
    const hasLines = invoice.lineItems && invoice.lineItems.length > 0;
    const estimateAmount = hasLines
      ? invoice.lineItems.reduce((s, li) => s + (li.quantity || 0) * (li.unitPrice || 0), 0)
      : invoice.amount;
    invoice.approvalRequired = this._requiresApproval(estimateAmount, data.businessConfig);
    invoice.approvalStatus = invoice.approvalRequired ? APPROVAL_STATUS.PENDING : APPROVAL_STATUS.NOT_REQUIRED;

    invoice.lastModifiedBy = user._id;
    await invoice.save(); // pre-save recomputes totals

    try {
      await auditService.log({
        businessId:      invoice.businessId,
        entityType:      ENTITY_TYPES.INVOICE,
        entityId:        invoice._id,
        action:          AUDIT_ACTIONS.EDITED,
        performedBy:     user._id,
        performedByName: user.fullName || user.email || 'Unknown',
        ipAddress,
      });
    } catch (e) {
      logger.warn(`[invoice] audit log (updateDraft) failed: ${e.message}`);
    }
    return invoice;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Approval workflow
  // ───────────────────────────────────────────────────────────────────────────

  async submitForApproval(id, user, ipAddress, opts = {}) {
    const invoice = await this._loadOrThrow(id, user?.businessId);
    if (!invoice.approvalRequired) {
      // Auto-promote to approved when approval is not required
      return this._applyStateChange(invoice, INVOICE_STATES.APPROVED, user, {
        reason: 'Below approval threshold — auto-approved',
        ipAddress,
      });
    }
    invoice.approvalLog.push({
      action:    'submitted',
      actorId:   user._id,
      actorName: user.fullName || user.email || 'Unknown',
      actorRole: user.role || null,
      timestamp: new Date(),
    });
    invoice.approvalStatus = APPROVAL_STATUS.PENDING;
    // M6 — build the multi-level approval chain when explicitly requested
    // (opt-in; default preserves the single-step approve flow). The same engine
    // also engages whenever a chain already exists on the document.
    if (opts.multiLevel && (!invoice.approvalChain || invoice.approvalChain.length === 0)) {
      const approvalEngine = require('./approvalEngine.service');
      invoice.approvalChain = approvalEngine.buildChain(invoice.totalAmount || invoice.amount || 0, opts);
    }
    return this._applyStateChange(invoice, INVOICE_STATES.PENDING_APPROVAL, user, { ipAddress });
  }

  /** M6 — advance/act on the multi-level approval chain (reject/reassign/escalate). */
  async actOnApproval(id, action, user, { note, level } = {}, ipAddress) {
    const invoice = await this._loadOrThrow(id, user?.businessId);
    const approvalEngine = require('./approvalEngine.service');
    if (!invoice.approvalChain || invoice.approvalChain.length === 0) {
      throw new ApiError(409, 'This invoice has no approval chain');
    }
    if (action === 'reject') {
      approvalEngine.rejectStep(invoice, user, note);
      invoice.approvalStatus = APPROVAL_STATUS.REJECTED;
      return this._applyStateChange(invoice, INVOICE_STATES.DRAFT, user, { reason: note || 'Rejected', ipAddress });
    }
    if (action === 'reassign') { approvalEngine.reassignStep(invoice, level, user, note); }
    else if (action === 'escalate') { approvalEngine.escalateStep(invoice, user, note); }
    else throw new ApiError(400, `Unknown approval action "${action}"`);
    invoice.lastModifiedBy = user._id;
    await invoice.save();
    return invoice;
  }

  async approve(id, user, note, ipAddress) {
    const invoice = await this._loadOrThrow(id, user?.businessId);

    // Phase 2: Check Customer Credit Limit
    if (invoice.customerId) {
      const Customer = require('../models/Customer.model');
      const customer = await Customer.findById(invoice.customerId).lean();
      if (customer && customer.creditLimit > 0) {
        const newBalance = (customer.currentReceivableBalance || 0) + invoice.totalAmount;
        if (newBalance > customer.creditLimit) {
          if (customer.creditLimitAction === 'block') {
            throw new ApiError(403, `Invoice approval blocked: exceeds customer credit limit of ${customer.creditLimit} (New Balance: ${newBalance})`);
          } else {
            logger.warn(`[invoice] Customer ${customer.fullName} exceeded credit limit (Limit: ${customer.creditLimit}, New Balance: ${newBalance}) upon invoice ${invoice.invoiceNumber} approval.`);
          }
        }
      }
    }

    // ── M6: multi-level approval — advance the chain one step ────────────────
    const approvalEngine = require('./approvalEngine.service');
    if (Array.isArray(invoice.approvalChain) && approvalEngine.currentStep(invoice.approvalChain)) {
      const res = approvalEngine.approveStep(invoice, user, note); // role + SoD validated
      invoice.approvalLog.push({ action: 'approved', actorId: user._id, actorName: user.fullName || user.email || 'Unknown', actorRole: user.role || null, note: note || null, timestamp: new Date() });
      if (!res.fullyApproved) {
        // Intermediate step — stay in pending_approval until the chain completes.
        invoice.lastModifiedBy = user._id;
        await invoice.save();
        return invoice;
      }
      // Final step approved → fall through to finalize (post recognition JE).
    }

    invoice.approvalLog.push({
      action:    'approved',
      actorId:   user._id,
      actorName: user.fullName || user.email || 'Unknown',
      actorRole: user.role || null,
      note:      note || null,
      timestamp: new Date(),
    });
    invoice.approvalStatus = APPROVAL_STATUS.APPROVED;
    invoice.approvedBy = user._id;
    invoice.approvedAt = new Date();
    const approved = await this._applyStateChange(invoice, INVOICE_STATES.APPROVED, user, { reason: note, ipAddress });

    // ── ERP Step 4: recognize AR in the ledger + on the customer balance ─────
    // Previously approve() posted NO ledger entry (despite the header comment) and
    // never moved the customer's receivable — so an approved invoice-first invoice
    // was invisible to the GL and to AR aging. postArJournal closes that gap.
    // Post the AR recognition journal. Do NOT swallow a failure — the GL must
    // reflect the receivable the moment an invoice is approved. The poster is
    // atomic and idempotent (guards on arJournalId), so a surfaced error can be
    // retried safely; a silent failure would leave AR understated (audit T3).
    await this.postArJournal(approved, user, ipAddress);

    businessEvents.emit(EVENTS.INVOICE_APPROVED, {
      businessId:    invoice.businessId.toString(),
      userId:        user._id,
      entityType:    ENTITY_TYPES.INVOICE,
      entityId:      invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      customerId:    invoice.customerId || null,
      amount:        invoice.totalAmount,
    });

    return approved;
  }

  async reject(id, user, note, ipAddress) {
    const invoice = await this._loadOrThrow(id, user?.businessId);
    invoice.approvalLog.push({
      action:    'rejected',
      actorId:   user._id,
      actorName: user.fullName || user.email || 'Unknown',
      actorRole: user.role || null,
      note:      note || null,
      timestamp: new Date(),
    });
    invoice.approvalStatus = APPROVAL_STATUS.REJECTED;
    // Move back to draft so user can correct and resubmit
    return this._applyStateChange(invoice, INVOICE_STATES.DRAFT, user, {
      reason: note || 'Rejected — returned to draft',
      ipAddress,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Other lifecycle ops
  // ───────────────────────────────────────────────────────────────────────────

  async send(id, user, ipAddress) {
    const invoice = await this._loadOrThrow(id, user?.businessId);
    invoice.sentAt = new Date();
    return this._applyStateChange(invoice, INVOICE_STATES.SENT, user, { ipAddress });
  }

  async cancel(id, user, reason, ipAddress) {
    const invoice = await this._loadOrThrow(id, user?.businessId);
    return this._applyStateChange(invoice, INVOICE_STATES.CANCELLED, user, { reason, ipAddress });
  }

  /** M5 — GL-correct void (reverses recognition + refunds payments; never deletes). */
  async void(id, reason, user, ipAddress) {
    const invoice = await this._loadOrThrow(id, user?.businessId);
    const arApVoidCredit = require('./arApVoidCredit.service');
    return arApVoidCredit.voidDocument('invoice', invoice, reason, user, ipAddress);
  }

  /** M5 — apply a customer credit memo (DR Sales Returns / CR AR) to this invoice. */
  async applyCreditMemo(id, amount, reason, user, ipAddress) {
    const invoice = await this._loadOrThrow(id, user?.businessId);
    const arApVoidCredit = require('./arApVoidCredit.service');
    return arApVoidCredit.applyCreditMemo('invoice', invoice, amount, reason, user, ipAddress);
  }

  /** M8 — preview the early-payment discount currently available on this invoice. */
  async previewEarlyPaymentDiscount(id, businessId = null) {
    const invoice = await this._loadOrThrow(id, businessId);
    return require('./earlyPaymentDiscount.service').preview('invoice', invoice);
  }

  /** M8 — realize the early-payment discount (DR Sales Returns / CR AR) if in window. */
  async applyEarlyPaymentDiscount(id, user, ipAddress) {
    const invoice = await this._loadOrThrow(id, user?.businessId);
    return require('./earlyPaymentDiscount.service').apply('invoice', invoice, user, ipAddress, {});
  }

  async dispute(id, user, reason, ipAddress) {
    const invoice = await this._loadOrThrow(id, user?.businessId);
    invoice.disputeReason = reason || null;
    invoice.disputedAt = new Date();
    return this._applyStateChange(invoice, INVOICE_STATES.DISPUTED, user, { reason, ipAddress });
  }

  async writeOff(id, user, reason, ipAddress) {
    const invoice = await this._loadOrThrow(id, user?.businessId);
    invoice.writeOffReason = reason || null;
    invoice.writtenOffAt   = new Date();

    // Post Bad Debt Expense journal entry: DR Bad Debt Expense / CR Accounts Receivable
    const outstanding = Math.round(
      ((invoice.remainingBalance != null ? invoice.remainingBalance : invoice.totalAmount) || 0) * 100
    ) / 100;

    // All-or-nothing (audit A10): the bad-debt journal (DR Bad Debt Expense / CR AR),
    // the customer-balance decrement and the WRITTEN_OFF state change commit together.
    // Previously the GL post sat in a swallowing try/catch and the state change ran
    // regardless — leaving an invoice written off with the receivable still open in
    // the GL (overstated assets, unrecorded expense).
    if (outstanding > 0) {
      return withTransaction(async (s) => {
        const [badDebtAcct, arAcct] = await Promise.all([
          ChartOfAccount.findOne({
            businessId: invoice.businessId,
            $or: [{ accountCode: '6370' }, { accountName: /bad debt/i }],
          }).lean(),
          ChartOfAccount.findOne({
            businessId: invoice.businessId,
            $or: [{ accountCode: '1110' }, { accountName: /accounts receivable/i }],
          }).lean(),
        ]);

        if (!badDebtAcct || !arAcct) {
          throw new ApiError(500, `Cannot write off invoice ${invoice.invoiceNumber}: Bad Debt Expense (6370) or Accounts Receivable (1110) account is not set up.`);
        }

        const je = await postBalancedJournal({
          businessId:         invoice.businessId,
          transactionDate:    new Date(),
          description:        `Write-off: Invoice ${invoice.invoiceNumber} — ${reason || 'bad debt'}`,
          transactionType:    TRANSACTION_TYPES.ADJUSTING_ENTRY,
          amount:             outstanding,
          debitAccountId:     badDebtAcct._id,
          creditAccountId:    arAcct._id,
          transactionSource:  TRANSACTION_SOURCES.SYSTEM_GENERATED,
          status:             JOURNAL_STATUS.POSTED,
          entryType:          'adjusting',
          invoiceNumber:      invoice.invoiceNumber,
          createdBy:          user._id,
          lastModifiedBy:     user._id,
          currencyCode:       invoice.currencyCode || 'PKR',
          baseCurrencyCode:   invoice.baseCurrencyCode || 'PKR',
          exchangeRate:       invoice.exchangeRate || 1,
          baseCurrencyAmount: outstanding,
        }, { session: s });
        invoice.writeOffJournalId = je._id;

        // Decrement the customer's receivable balance
        if (invoice.customerId) {
          await partyBalanceService.adjustReceivable(
            invoice.businessId,
            invoice.customerId,
            -outstanding,
            { userId: user._id, reason: 'write_off', entityType: ENTITY_TYPES.INVOICE, entityId: invoice._id, session: s }
          );
        }

        return this._applyStateChange(invoice, INVOICE_STATES.WRITTEN_OFF, user, { reason, ipAddress, session: s });
      });
    }

    return this._applyStateChange(invoice, INVOICE_STATES.WRITTEN_OFF, user, { reason, ipAddress });
  }

  async markPaid(id, user, ipAddress) {
    const invoice = await this._loadOrThrow(id, user?.businessId);
    const outstanding = Math.round(
      ((invoice.remainingBalance != null ? invoice.remainingBalance : invoice.totalAmount) || 0) * 100
    ) / 100;

    invoice.paidAmount = invoice.totalAmount;
    invoice.remainingBalance = 0;

    // ── ERP Step 4: settle the AR + customer balance ─────────────────────────
    // Only for invoices that recognized their OWN AR (invoice-first flow,
    // identified by arJournalId). Transaction-first invoices (synced from a
    // journal entry) are settled via transaction.service, which owns that
    // balance lifecycle — skipping them prevents a double-decrement. (Rules 4, 5)
    // All-or-nothing (audit A10): the PAID state change, the cash-settlement journal
    // and the customer-balance decrement commit together. Previously the state change
    // committed first and a settlement failure was swallowed — leaving the invoice
    // marked PAID while the AR balance stayed open in the GL.
    let paid;
    if (invoice.arJournalId && invoice.customerId && outstanding > 0) {
      paid = await withTransaction(async (s) => {
        const p = await this._applyStateChange(invoice, INVOICE_STATES.PAID, user, { ipAddress, session: s });
        await this._postInvoiceSettlementJournal(invoice, outstanding, user, s);
        await partyBalanceService.adjustReceivable(invoice.businessId, invoice.customerId, -outstanding, {
          userId: user._id, reason: 'invoice_paid', entityType: ENTITY_TYPES.INVOICE, entityId: invoice._id, session: s,
        });
        return p;
      });
    } else {
      paid = await this._applyStateChange(invoice, INVOICE_STATES.PAID, user, { ipAddress });
    }

    // Broadcast regardless so downstream caches refresh on any payment path.
    businessEvents.emit(EVENTS.INVOICE_PAID, {
      businessId:    invoice.businessId.toString(),
      userId:        user._id,
      entityType:    ENTITY_TYPES.INVOICE,
      entityId:      invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      customerId:    invoice.customerId || null,
      amount:        invoice.totalAmount,
    });

    return paid;
  }

  /** Generic state transition entry point (used by tests + admin tooling). */
  async transitionState(id, toState, user, { reason = null, ipAddress = null } = {}) {
    const invoice = await this._loadOrThrow(id, user?.businessId);
    return this._applyStateChange(invoice, toState, user, { reason, ipAddress });
  }

  async softDelete(id, user, ipAddress) {
    const invoice = await this._loadOrThrow(id, user?.businessId);
    if (invoice.isArchived) return invoice;
    invoice.isArchived = true;
    invoice.archivedAt = new Date();
    invoice.archivedBy = user._id;
    invoice.lastModifiedBy = user._id;
    await invoice.save();
    try {
      await auditService.logDelete(
        ENTITY_TYPES.INVOICE,
        invoice._id,
        invoice.businessId,
        user._id,
        invoice.toObject(),
        ipAddress
      );
    } catch (e) {
      logger.warn(`[invoice] audit logDelete failed: ${e.message}`);
    }
    return invoice;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ERP Step 4 — AR Recognition + Settlement Journals
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Post the Accounts-Receivable recognition journal when an invoice is approved.
   *
   * Accounting entry:
   *   DR  Accounts Receivable  (1110)
   *   CR  Sales / Revenue      (line-item account → 4110 → 4150/4120 fallback)
   *
   * If the invoice has output tax, a second entry is created:
   *   DR  Accounts Receivable     (1110)
   *   CR  GST / Output Tax Payable (2120)
   *
   * Both are tagged system_generated and posted via ledgerPosting so the
   * Chart-of-Accounts running balances stay correct (GAAP trial balance). The
   * customer's currentReceivableBalance is then incremented by exactly the
   * amount debited to the AR control account — keeping "AR control == Σ customer
   * balances" — and CUSTOMER_BALANCE_CHANGED is broadcast.
   *
   * Idempotent: skips if arJournalId or linkedJournalEntryId already set, so the
   * transaction-first dual-write path (which sets linkedJournalEntryId) is never
   * double-posted.
   *
   * @returns {Promise<Object|null>}  the primary JournalEntry, or null if skipped
   */
  async postArJournal(invoice, user, ipAddress) {
    if (invoice.arJournalId || invoice.linkedJournalEntryId) {
      logger.debug(`[invoice] skipping AR journal for ${invoice.invoiceNumber} — JE already exists`);
      return null;
    }

    const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
    const businessId = invoice.businessId;

    // ── AR control account (1110) ────────────────────────────────────────────
    const arAccount = await ChartOfAccount.findOne({ businessId, accountCode: '1110' }).lean();
    if (!arAccount) {
      logger.warn(`[invoice] AR journal skipped for ${invoice.invoiceNumber} — Accounts Receivable (1110) not found`);
      return null;
    }

    // ── Revenue (credit) account: line-item account → Sales (4110) → fallbacks ──
    let revenueAccountId = null;
    if (invoice.lineItems && invoice.lineItems.length > 0) {
      const firstWithAccount = invoice.lineItems.find((li) => li.accountId);
      if (firstWithAccount) revenueAccountId = firstWithAccount.accountId;
    }
    if (!revenueAccountId) {
      const revenueAcc = await ChartOfAccount.findOne({
        businessId,
        accountCode: { $in: ['4110', '4150', '4120', '4100'] },
      }).lean();
      if (revenueAcc) revenueAccountId = revenueAcc._id;
    }
    if (!revenueAccountId) {
      logger.warn(`[invoice] AR journal skipped for ${invoice.invoiceNumber} — no revenue account found`);
      return null;
    }
    if (revenueAccountId.toString() === arAccount._id.toString()) {
      logger.warn(`[invoice] AR journal skipped — debit and credit are the same account`);
      return null;
    }

    const netAmount = r2(invoice.amount || (invoice.totalAmount - (invoice.taxAmount || 0)));
    const primaryAmount = netAmount > 0 ? netAmount : r2(invoice.totalAmount);

    // ── Resolve the optional output-tax account up-front (read, no write) ────
    const taxAmount = r2(invoice.taxAmount || 0);
    let outputTaxAcc = null;
    if (taxAmount > 0) {
      const acc = await ChartOfAccount.findOne({
        businessId,
        accountCode: { $in: ['2120', '2125'] }, // GST Payable → WHT Payable fallback
      }).lean();
      if (acc && acc._id.toString() !== arAccount._id.toString()) outputTaxAcc = acc;
    }

    // ── R-01: recognize AR atomically ────────────────────────────────────────
    // The primary JE, the optional output-tax JE, the invoice document update and
    // the customer balance move now commit together or roll back together. On a
    // standalone dev server withTransaction runs them without a session (legacy
    // behaviour). A failure rolls everything back, so we can never half-recognize
    // an invoice (e.g. AR posted but the tax leg or customer balance missing).
    let primaryJe = null;
    const preLinked = invoice.linkedJournalEntryId; // remember to restore on rollback
    try {
      await withTransaction(async (session) => {
        let arDebited = 0;
        primaryJe = await postBalancedJournal({
          businessId,
          transactionDate:   invoice.issueDate,
          description:       `AR Recognition — ${invoice.invoiceNumber}${invoice.customerSnapshot?.fullName ? ' (' + invoice.customerSnapshot.fullName + ')' : ''}`,
          transactionType:   TRANSACTION_TYPES.CREDIT_SALE,
          amount:            primaryAmount,
          debitAccountId:    arAccount._id,
          creditAccountId:   revenueAccountId,
          status:            JOURNAL_STATUS.POSTED,
          transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
          invoiceNumber:     invoice.invoiceNumber,
          customerId:        invoice.customerId || null,
          currencyCode:      invoice.currencyCode || 'PKR',
          exchangeRate:      invoice.exchangeRate || 1,
          createdBy:         user._id,
          lastModifiedBy:    user._id,
          // M9 — this entry is the immutable projection of the authoritative invoice.
          isProjection:      true,
          projectionOf:      { documentType: 'invoice', documentId: invoice._id },
        }, { session });
        arDebited = r2(arDebited + primaryAmount);

        invoice.arJournalId = primaryJe._id;
        if (!invoice.linkedJournalEntryId) invoice.linkedJournalEntryId = primaryJe._id;
        await invoice.save({ session });

        // Output-tax JE: DR Accounts Receivable, CR GST/Output Tax Payable.
        // taxAmount/taxType are tagged so this entry is visible to the tax
        // return (taxReport sums JE.taxAmount). 'GST Payable' → taxType 'GST'.
        if (outputTaxAcc) {
          const outputTaxType = (outputTaxAcc.accountName || 'Tax')
            .replace(/\b(Payable|Receivable)\b/ig, '').replace(/\(.*?\)/g, '').trim() || 'Tax';
          await postBalancedJournal({
            businessId,
            transactionDate:   invoice.issueDate,
            description:       `AR Output Tax — ${invoice.invoiceNumber}`,
            transactionType:   TRANSACTION_TYPES.CREDIT_SALE,
            amount:            taxAmount,
            taxAmount:         taxAmount,
            taxType:           outputTaxType,
            debitAccountId:    arAccount._id,
            creditAccountId:   outputTaxAcc._id,
            status:            JOURNAL_STATUS.POSTED,
            transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
            invoiceNumber:     invoice.invoiceNumber,
            customerId:        invoice.customerId || null,
            currencyCode:      invoice.currencyCode || 'PKR',
            exchangeRate:      invoice.exchangeRate || 1,
            createdBy:         user._id,
            lastModifiedBy:    user._id,
          }, { session });
          arDebited = r2(arDebited + taxAmount);
        }

        // Mirror the AR debit onto the customer's receivable balance.
        if (invoice.customerId && arDebited > 0) {
          await partyBalanceService.adjustReceivable(businessId, invoice.customerId, arDebited, {
            userId: user._id, reason: 'invoice_approved', entityType: ENTITY_TYPES.INVOICE, entityId: invoice._id, session,
          });
        }
      });
    } catch (e) {
      // Everything rolled back atomically — undo the in-memory mutations so the
      // returned doc doesn't reference a JE that no longer exists, then RE-THROW.
      // Never swallow: an invoice must not be reported as approved while its AR
      // recognition silently failed to post (audit T3, mirrors the bill AP fix).
      // Guard fields are reset so a retry re-posts cleanly.
      invoice.arJournalId = undefined;
      invoice.linkedJournalEntryId = preLinked;
      logger.error(`[invoice] AR recognition rolled back for ${invoice.invoiceNumber}: ${e.message}`);
      throw e;
    }

    // ── ERP Step 5: recognize COGS + reduce inventory for product line items ──
    // Matching principle — COGS is recognized in the same step as the revenue.
    // Best-effort: a stock/COGS hiccup must never roll back AR recognition.
    try {
      await this._applyCogsForInvoice(invoice, user);
    } catch (e) {
      logger.warn(`[invoice] COGS recognition failed for ${invoice.invoiceNumber}: ${e.message}`);
    }

    return primaryJe;
  }

  /**
   * ERP Step 5 — reduce inventory and post the COGS journal for an invoice's
   * product line items (invoice-first flow only — the transaction-first path
   * already does this in transaction.service, and its synced invoice carries a
   * linkedJournalEntryId that short-circuits postArJournal before we get here).
   *
   *   DR  Cost of Goods Sold
   *   CR  Inventory
   *
   * Stock is reduced per line via inventoryService.reduceStock (which emits
   * INVENTORY_REDUCED / VALUATION_CHANGED / LOW_STOCK and fires reorder email),
   * then one consolidated COGS journal is posted at weighted-average cost.
   * @private
   */
  async _applyCogsForInvoice(invoice, user) {
    const inventoryService = require('./inventory.service'); // lazy — avoid cycle
    const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

    const productLines = (invoice.lineItems || []).filter(
      (li) => li.inventoryItemId && Number(li.quantity) > 0
    );
    if (productLines.length === 0) return null;

    let totalCogs = 0;
    for (const li of productLines) {
      try {
        const { cogsAmount } = await inventoryService.reduceStock(
          invoice.businessId, li.inventoryItemId, Number(li.quantity)
        );
        totalCogs = r2(totalCogs + (cogsAmount || 0));
      } catch (e) {
        logger.warn(`[invoice] stock reduction failed for item ${li.inventoryItemId} on ${invoice.invoiceNumber}: ${e.message}`);
      }
    }
    if (totalCogs <= 0) return null;

    const { cogsAccountId, inventoryAccountId } = await inventoryService.resolveCostAccounts(invoice.businessId);
    if (!cogsAccountId || !inventoryAccountId) {
      logger.warn(`[invoice] COGS journal skipped for ${invoice.invoiceNumber} — COGS/Inventory account not found (stock already reduced)`);
      return totalCogs;
    }

    await postBalancedJournal({
      businessId:        invoice.businessId,
      transactionDate:   invoice.issueDate,
      description:       `COGS — ${invoice.invoiceNumber}`,
      transactionType:   TRANSACTION_TYPES.EXPENSE,
      amount:            totalCogs,
      debitAccountId:    cogsAccountId,        // DR Cost of Goods Sold
      creditAccountId:   inventoryAccountId,   // CR Inventory
      status:            JOURNAL_STATUS.POSTED,
      transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
      invoiceNumber:     invoice.invoiceNumber,
      customerId:        invoice.customerId || null,
      currencyCode:      invoice.currencyCode || 'PKR',
      exchangeRate:      invoice.exchangeRate || 1,
      createdBy:         user._id,
      lastModifiedBy:    user._id,
    });
    logger.info(`[invoice] ${invoice.invoiceNumber}: recognized COGS ${totalCogs} for ${productLines.length} line(s)`);
    return totalCogs;
  }

  /**
   * ERP Step 4 — post the cash-settlement journal for an invoice payment.
   *   DR  Cash / Bank (1010…)        — money arrives
   *   CR  Accounts Receivable (1110) — clears the receivable
   * Balanced + running-balance-synced via ledgerPosting. Returns null (logged)
   * if the AR or a cash/bank account can't be resolved, rather than throwing.
   * @private
   */
  async _postInvoiceSettlementJournal(invoice, amount, user, session = null) {
    const businessId = invoice.businessId;
    // Independent lookups — fetch in parallel to save a DB round-trip (Step 10).
    const [arAccount, cashAccount] = await Promise.all([
      ChartOfAccount.findOne({ businessId, accountCode: '1110' }).lean(),
      ChartOfAccount.findOne({
        businessId,
        accountCode: { $in: ['1010', '1020', '1040', '1030'] }, // Cash at Bank → on Hand → Savings → Petty
      }).lean(),
    ]);
    // Can't post → throw so the caller's transaction rolls back (audit A10). Marking
    // an invoice PAID with no settlement journal would leave the AR open.
    if (!arAccount || !cashAccount) {
      throw new ApiError(500, `Cannot settle invoice ${invoice.invoiceNumber}: Accounts Receivable (1110) or a cash/bank account is not set up.`);
    }
    if (arAccount._id.toString() === cashAccount._id.toString()) {
      throw new ApiError(500, `Cannot settle invoice ${invoice.invoiceNumber}: AR and cash resolve to the same account.`);
    }

    return postBalancedJournal({
      businessId,
      transactionDate:   new Date(),
      description:       `Invoice Payment — ${invoice.invoiceNumber}${invoice.customerSnapshot?.fullName ? ' (' + invoice.customerSnapshot.fullName + ')' : ''}`,
      transactionType:   TRANSACTION_TYPES.PAYMENT_RECEIVED,
      amount,
      debitAccountId:    cashAccount._id,
      creditAccountId:   arAccount._id,
      status:            JOURNAL_STATUS.POSTED,
      transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
      invoiceNumber:     invoice.invoiceNumber,
      customerId:        invoice.customerId || null,
      currencyCode:      invoice.currencyCode || 'PKR',
      exchangeRate:      invoice.exchangeRate || 1,
      createdBy:         user._id,
      lastModifiedBy:    user._id,
    }, { session });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Sync helper (used by transaction.service dual-write)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Idempotent — given a freshly-created JournalEntry (Credit Sale / Inventory Sale),
   * create or update the matching Invoice record.  Existing Invoices are not
   * duplicated; the function is safe to call repeatedly for the same JE.
   */
  async syncFromJournalEntry(je, user, ipAddress) {
    if (!je || !je.invoiceNumber) return null;
    const existing = await Invoice.findOne({
      businessId:    je.businessId,
      invoiceNumber: je.invoiceNumber,
    });
    if (existing) {
      if (!existing.linkedJournalEntryId) {
        existing.linkedJournalEntryId = je._id;
        await existing.save();
      }
      return existing;
    }
    const snap = await this._customerSnapshot(je.businessId, je.customerId);
    // Compute initial state from journal-entry payment status
    let initialState = INVOICE_STATES.APPROVED; // ledger posted ⇒ approved
    if (je.paymentStatus === 'paid')           initialState = INVOICE_STATES.PAID;
    else if (je.paymentStatus === 'partially_paid') initialState = INVOICE_STATES.PARTIALLY_PAID;
    else if (je.paymentStatus === 'overdue')   initialState = INVOICE_STATES.OVERDUE;

    const totalAmount = (je.amount || 0) + (je.taxAmount || 0);
    const approvalRequired = this._requiresApproval(totalAmount);

    const invoice = new Invoice({
      businessId:           je.businessId,
      invoiceNumber:        je.invoiceNumber,
      linkedJournalEntryId: je._id,
      customerId:           je.customerId || null,
      customerSnapshot:     snap,
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
    invoice.recordStateChange(initialState, user, 'Auto-created from journal entry');
    if (approvalRequired) {
      invoice.approvalLog.push({
        action:    'approved',
        actorId:   user._id,
        actorName: user.fullName || user.email || 'System',
        note:      'Auto-approved (created via direct journal posting)',
        timestamp: new Date(),
      });
    }
    await invoice.save();
    try {
      await auditService.logCreate(
        ENTITY_TYPES.INVOICE,
        invoice._id,
        invoice.businessId,
        user._id,
        invoice.toObject(),
        ipAddress
      );
    } catch (e) {
      logger.warn(`[invoice] audit logCreate (sync) failed: ${e.message}`);
    }
    return invoice;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Read APIs
  // ───────────────────────────────────────────────────────────────────────────

  async _loadOrThrow(id, businessId = null) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, 'Invalid invoice id');
    }
    // R-05: scope by tenant when businessId is supplied so one business can
    // never load/mutate another business's invoice via a foreign id.
    const invoice = businessId
      ? await Invoice.findOne({ _id: id, businessId })
      : await Invoice.findById(id);
    if (!invoice) throw new ApiError(404, 'Invoice not found');
    if (invoice.isArchived) throw new ApiError(410, 'Invoice has been archived');
    return invoice;
  }

  async getById(id, businessId) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, 'Invalid invoice id');
    }
    const query = { _id: id };
    if (businessId) query.businessId = businessId;
    const invoice = await Invoice.findOne(query);
    if (!invoice) throw new ApiError(404, 'Invoice not found');
    return invoice;
  }

  async list(businessId, filters = {}, pagination = {}) {
    const { page = 1, limit = 25 } = pagination;
    const q = { businessId, isArchived: { $ne: true } };
    if (filters.state) q.state = filters.state;
    if (filters.customerId) q.customerId = filters.customerId;
    if (filters.approvalStatus) q.approvalStatus = filters.approvalStatus;
    if (filters.search) q.invoiceNumber = { $regex: filters.search, $options: 'i' };
    if (filters.startDate || filters.endDate) {
      q.issueDate = {};
      if (filters.startDate) q.issueDate.$gte = new Date(filters.startDate);
      if (filters.endDate)   q.issueDate.$lte = new Date(filters.endDate);
    }
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      Invoice.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Invoice.countDocuments(q),
    ]);
    return { data, total, page, limit };
  }

  /** Full timeline = approval log + state history + field history, sorted desc. */
  async getTimeline(id, businessId) {
    const invoice = await this.getById(id, businessId);
    const entries = [];
    for (const e of (invoice.approvalLog || [])) {
      entries.push({ type: 'approval', timestamp: e.timestamp, ...e.toObject?.() ?? e });
    }
    for (const e of (invoice.stateHistory || [])) {
      entries.push({ type: 'state', timestamp: e.timestamp, ...e.toObject?.() ?? e });
    }
    for (const e of (invoice.fieldHistory || [])) {
      entries.push({ type: 'field', timestamp: e.changedAt, ...e.toObject?.() ?? e });
    }
    entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return { invoice, timeline: entries };
  }
}

module.exports = new InvoiceService();

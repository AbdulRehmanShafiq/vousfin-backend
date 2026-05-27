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
const customerRepository = require('../repositories/customer.repository');
const auditService = require('./audit.service');
const fxService = require('./fx.service');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const {
  INVOICE_STATES,
  APPROVAL_STATUS,
  AUDIT_ACTIONS,
  ENTITY_TYPES,
  DEFAULT_APPROVAL_THRESHOLD,
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
  async _applyStateChange(invoice, toState, user, { reason = null, ipAddress = null } = {}) {
    this._guardTransition(invoice, toState);
    const fromState = invoice.state;
    invoice.recordStateChange(toState, user, reason);
    invoice.state = toState;
    invoice.lastModifiedBy = user._id;
    await invoice.save();

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
  async createDraft(data, user, ipAddress) {
    const hasLines = Array.isArray(data.lineItems) && data.lineItems.length > 0;
    if (!data.businessId || !data.invoiceNumber || !data.issueDate) {
      throw new ApiError(400, 'createDraft requires: businessId, invoiceNumber, issueDate');
    }
    if (!hasLines && (!data.amount || data.amount <= 0)) {
      throw new ApiError(400, 'Invoice amount must be greater than zero (or provide lineItems)');
    }

    const snap = await this._customerSnapshot(data.businessId, data.customerId);

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
      dueDate:           data.dueDate || null,
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
    const invoice = await this._loadOrThrow(id);
    if (invoice.state !== INVOICE_STATES.DRAFT) {
      throw new ApiError(409, 'Only draft invoices can be edited');
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

  async submitForApproval(id, user, ipAddress) {
    const invoice = await this._loadOrThrow(id);
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
    return this._applyStateChange(invoice, INVOICE_STATES.PENDING_APPROVAL, user, { ipAddress });
  }

  async approve(id, user, note, ipAddress) {
    const invoice = await this._loadOrThrow(id);
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
    return this._applyStateChange(invoice, INVOICE_STATES.APPROVED, user, { reason: note, ipAddress });
  }

  async reject(id, user, note, ipAddress) {
    const invoice = await this._loadOrThrow(id);
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
    const invoice = await this._loadOrThrow(id);
    invoice.sentAt = new Date();
    return this._applyStateChange(invoice, INVOICE_STATES.SENT, user, { ipAddress });
  }

  async cancel(id, user, reason, ipAddress) {
    const invoice = await this._loadOrThrow(id);
    return this._applyStateChange(invoice, INVOICE_STATES.CANCELLED, user, { reason, ipAddress });
  }

  async dispute(id, user, reason, ipAddress) {
    const invoice = await this._loadOrThrow(id);
    invoice.disputeReason = reason || null;
    invoice.disputedAt = new Date();
    return this._applyStateChange(invoice, INVOICE_STATES.DISPUTED, user, { reason, ipAddress });
  }

  async writeOff(id, user, reason, ipAddress) {
    const invoice = await this._loadOrThrow(id);
    invoice.writeOffReason = reason || null;
    invoice.writtenOffAt = new Date();
    return this._applyStateChange(invoice, INVOICE_STATES.WRITTEN_OFF, user, { reason, ipAddress });
  }

  async markPaid(id, user, ipAddress) {
    const invoice = await this._loadOrThrow(id);
    invoice.paidAmount = invoice.totalAmount;
    invoice.remainingBalance = 0;
    return this._applyStateChange(invoice, INVOICE_STATES.PAID, user, { ipAddress });
  }

  /** Generic state transition entry point (used by tests + admin tooling). */
  async transitionState(id, toState, user, { reason = null, ipAddress = null } = {}) {
    const invoice = await this._loadOrThrow(id);
    return this._applyStateChange(invoice, toState, user, { reason, ipAddress });
  }

  async softDelete(id, user, ipAddress) {
    const invoice = await this._loadOrThrow(id);
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

  async _loadOrThrow(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, 'Invalid invoice id');
    }
    const invoice = await Invoice.findById(id);
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

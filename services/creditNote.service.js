// services/creditNote.service.js
//
// Phase 2 — Credit Note / Debit Note lifecycle service.
//
// Public API:
//   create(data, user, ip)       → CreditNote (state=draft)
//   approve(id, user, ip)        → CreditNote (state=approved, updates Invoice.totalCredited)
//   apply(id, user, ip)          → CreditNote (state=applied, adjusts Invoice.remainingBalance)
//   cancel(id, user, ip)         → CreditNote (state=cancelled, reverses credit)
//   getById(id, businessId)      → CreditNote
//   listByInvoice(invoiceId, biz)→ CreditNote[]
//   list(businessId, filters)    → { data, total }
//

const mongoose = require('mongoose');
const CreditNote = require('../models/CreditNote.model');
const Invoice = require('../models/Invoice.model');
const customerRepository = require('../repositories/customer.repository');
const auditService = require('./audit.service');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const { ENTITY_TYPES, AUDIT_ACTIONS } = require('../config/constants');

class CreditNoteService {
  // ───────────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────────

  async _loadOrThrow(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, 'Invalid credit note id');
    }
    const cn = await CreditNote.findById(id);
    if (!cn) throw new ApiError(404, 'Credit note not found');
    if (cn.isArchived) throw new ApiError(410, 'Credit note has been archived');
    return cn;
  }

  async _customerSnapshot(businessId, customerId) {
    if (!customerId) return {};
    const c = await customerRepository.findByBusinessAndId(businessId, customerId);
    if (!c) return {};
    return {
      fullName:     c.fullName || null,
      businessName: c.businessName || null,
      email:        c.email || null,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Create
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Create a credit note (or debit note) linked to an invoice.
   * Validates that the credit amount does not exceed the invoice's remaining creditable balance.
   */
  async create(data, user, ipAddress) {
    if (!data.businessId || !data.invoiceId || !data.creditNoteNumber || !data.issueDate) {
      throw new ApiError(400, 'create requires: businessId, invoiceId, creditNoteNumber, issueDate');
    }

    // Load originating invoice
    const invoice = await Invoice.findOne({
      _id: data.invoiceId,
      businessId: data.businessId,
    });
    if (!invoice) throw new ApiError(404, 'Originating invoice not found');

    // Validate credit amount does not exceed what's creditable
    const hasLines = Array.isArray(data.lineItems) && data.lineItems.length > 0;
    const estimatedTotal = hasLines
      ? data.lineItems.reduce((s, li) => s + (li.quantity || 0) * (li.unitPrice || 0), 0)
      : data.totalAmount || 0;

    if (data.noteType !== 'debit_note') {
      const alreadyCredited = invoice.totalCredited || 0;
      const maxCreditable = invoice.totalAmount - alreadyCredited;
      if (estimatedTotal > maxCreditable + 0.01) {
        throw new ApiError(400, `Credit amount (${estimatedTotal}) exceeds remaining creditable balance (${maxCreditable})`);
      }
    }

    const snap = await this._customerSnapshot(data.businessId, data.customerId || invoice.customerId);

    const cn = new CreditNote({
      businessId:        data.businessId,
      creditNoteNumber:  data.creditNoteNumber,
      noteType:          data.noteType || 'credit_note',
      invoiceId:         data.invoiceId,
      invoiceNumber:     invoice.invoiceNumber,
      customerId:        data.customerId || invoice.customerId || null,
      customerSnapshot:  snap,
      lineItems:         data.lineItems || [],
      subtotal:          0, // computed by pre-save
      taxAmount:         0,
      totalAmount:       data.totalAmount || 0.01, // pre-save overrides if lineItems
      currencyCode:      data.currencyCode || invoice.currencyCode || 'PKR',
      baseCurrencyCode:  invoice.baseCurrencyCode || 'PKR',
      exchangeRate:      data.exchangeRate || invoice.exchangeRate || 1,
      state:             'draft',
      issueDate:         data.issueDate,
      reason:            data.reason || null,
      notes:             data.notes || null,
      createdBy:         user._id,
      lastModifiedBy:    user._id,
    });

    await cn.save();

    try {
      await auditService.logCreate(
        ENTITY_TYPES.INVOICE, // grouped under invoice entity for audit trail
        cn._id,
        cn.businessId,
        user._id,
        cn.toObject(),
        ipAddress
      );
    } catch (e) {
      logger.warn(`[creditNote] audit logCreate failed: ${e.message}`);
    }
    return cn;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Approve
  // ───────────────────────────────────────────────────────────────────────────

  async approve(id, user, ipAddress) {
    const cn = await this._loadOrThrow(id);
    if (cn.state !== 'draft') {
      throw new ApiError(409, `Credit note cannot be approved from state "${cn.state}"`);
    }
    cn.state = 'approved';
    cn.approvedBy = user._id;
    cn.approvedAt = new Date();
    cn.lastModifiedBy = user._id;
    await cn.save();
    return cn;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Apply (adjusts invoice balances)
  // ───────────────────────────────────────────────────────────────────────────

  async apply(id, user, ipAddress) {
    const cn = await this._loadOrThrow(id);
    if (cn.state !== 'approved') {
      throw new ApiError(409, `Credit note must be approved before applying (current: "${cn.state}")`);
    }

    // Update the originating invoice
    const invoice = await Invoice.findById(cn.invoiceId);
    if (!invoice) throw new ApiError(404, 'Originating invoice not found');

    if (cn.noteType === 'credit_note') {
      invoice.totalCredited = (invoice.totalCredited || 0) + cn.totalAmount;
      invoice.remainingBalance = Math.max(0, (invoice.remainingBalance ?? invoice.totalAmount) - cn.totalAmount);
      if (!invoice.creditNoteIds) invoice.creditNoteIds = [];
      invoice.creditNoteIds.push(cn._id);
    } else {
      // Debit note: increases amount owed
      invoice.remainingBalance = (invoice.remainingBalance ?? invoice.totalAmount) + cn.totalAmount;
    }
    invoice.lastModifiedBy = user._id;
    await invoice.save();

    cn.state = 'applied';
    cn.lastModifiedBy = user._id;
    await cn.save();
    return cn;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Cancel
  // ───────────────────────────────────────────────────────────────────────────

  async cancel(id, user, reason, ipAddress) {
    const cn = await this._loadOrThrow(id);
    if (cn.state === 'cancelled') return cn;

    // If it was applied, reverse the invoice adjustment
    if (cn.state === 'applied') {
      const invoice = await Invoice.findById(cn.invoiceId);
      if (invoice) {
        if (cn.noteType === 'credit_note') {
          invoice.totalCredited = Math.max(0, (invoice.totalCredited || 0) - cn.totalAmount);
          invoice.remainingBalance = (invoice.remainingBalance || 0) + cn.totalAmount;
          invoice.creditNoteIds = (invoice.creditNoteIds || []).filter(
            cid => String(cid) !== String(cn._id)
          );
        } else {
          invoice.remainingBalance = Math.max(0, (invoice.remainingBalance || 0) - cn.totalAmount);
        }
        invoice.lastModifiedBy = user._id;
        await invoice.save();
      }
    }

    cn.state = 'cancelled';
    cn.lastModifiedBy = user._id;
    await cn.save();
    return cn;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Read
  // ───────────────────────────────────────────────────────────────────────────

  async getById(id, businessId) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, 'Invalid credit note id');
    }
    const q = { _id: id };
    if (businessId) q.businessId = businessId;
    const cn = await CreditNote.findOne(q);
    if (!cn) throw new ApiError(404, 'Credit note not found');
    return cn;
  }

  async listByInvoice(invoiceId, businessId) {
    return CreditNote.find({
      invoiceId,
      businessId,
      isArchived: { $ne: true },
    }).sort({ createdAt: -1 });
  }

  async list(businessId, filters = {}, pagination = {}) {
    const { page = 1, limit = 25 } = pagination;
    const q = { businessId, isArchived: { $ne: true } };
    if (filters.state) q.state = filters.state;
    if (filters.invoiceId) q.invoiceId = filters.invoiceId;
    if (filters.noteType) q.noteType = filters.noteType;
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      CreditNote.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit),
      CreditNote.countDocuments(q),
    ]);
    return { data, total, page, limit };
  }

  async softDelete(id, user, ipAddress) {
    const cn = await this._loadOrThrow(id);
    if (cn.isArchived) return cn;
    // If applied, reverse first
    if (cn.state === 'applied') {
      await this.cancel(id, user, 'Archived', ipAddress);
    }
    cn.isArchived = true;
    cn.archivedAt = new Date();
    cn.archivedBy = user._id;
    await cn.save();
    return cn;
  }
}

module.exports = new CreditNoteService();

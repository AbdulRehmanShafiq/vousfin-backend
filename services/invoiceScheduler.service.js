// services/invoiceScheduler.service.js
//
// AR/AP Refactor — Milestone M8 (recurring invoices).
//
// AR mirror of billScheduler.service. Responsibilities:
//   1. CRUD for InvoiceSchedule documents
//   2. generateDueInvoices() — cron-called; creates draft Invoice docs from schedules
//   3. computeNextRunDate(pattern, from)
//
// Generated invoices are created as DRAFTs (or pending_approval when autoSubmit),
// carry the schedule's structured payment terms (which derive dueDate + discount
// window), and are tagged isRecurring + recurringScheduleId for traceability.
// The scheduler NEVER posts to the ledger — recognition happens on approval via
// the normal invoice lifecycle, so ledger integrity is unaffected.
//
'use strict';
const mongoose = require('mongoose');
const InvoiceSchedule = require('../models/InvoiceSchedule.model');
const Invoice = require('../models/Invoice.model');
const Customer = require('../models/Customer.model');
const auditService = require('./audit.service');
const paymentTermsUtil = require('../utils/paymentTerms');
const { businessEvents, EVENTS } = require('./businessEventEngine.service');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const {
  RECURRENCE_PATTERNS, INVOICE_STATES, APPROVAL_STATUS,
  ENTITY_TYPES, AUDIT_ACTIONS,
} = require('../config/constants');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

class InvoiceSchedulerService {
  _validateId(id, label = 'id') {
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, `Invalid ${label}`);
    }
  }

  /** Advance a date by one recurrence period. */
  computeNextRunDate(pattern, from) {
    const d = new Date(from);
    switch (pattern) {
      case RECURRENCE_PATTERNS.WEEKLY:    d.setDate(d.getDate() + 7);          break;
      case RECURRENCE_PATTERNS.BIWEEKLY:  d.setDate(d.getDate() + 14);         break;
      case RECURRENCE_PATTERNS.MONTHLY:   d.setMonth(d.getMonth() + 1);        break;
      case RECURRENCE_PATTERNS.QUARTERLY: d.setMonth(d.getMonth() + 3);        break;
      case RECURRENCE_PATTERNS.ANNUAL:    d.setFullYear(d.getFullYear() + 1);  break;
      default: throw new ApiError(400, `Unknown recurrence pattern: ${pattern}`);
    }
    return d;
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────
  async create(businessId, data, actor) {
    this._validateId(businessId, 'businessId');
    if (!data.name) throw new ApiError(400, 'Schedule name is required');
    if (!data.recurrencePattern) throw new ApiError(400, 'recurrencePattern is required');
    if (!Object.values(RECURRENCE_PATTERNS).includes(data.recurrencePattern)) {
      throw new ApiError(400, `Invalid recurrencePattern: ${data.recurrencePattern}`);
    }
    if (!data.startDate) throw new ApiError(400, 'startDate is required');
    if (!Array.isArray(data.lineItems) || data.lineItems.length === 0) {
      throw new ApiError(400, 'At least one line item is required');
    }

    const startDate = new Date(data.startDate);
    const schedule = await InvoiceSchedule.create({
      businessId,
      customerId:        data.customerId || null,
      name:              data.name,
      description:       data.description || null,
      recurrencePattern: data.recurrencePattern,
      startDate,
      endDate:           data.endDate ? new Date(data.endDate) : null,
      nextRunDate:       startDate,
      lineItems:         data.lineItems,
      currencyCode:      data.currencyCode || 'PKR',
      paymentTermsCode:  data.paymentTermsCode || 'NET_30',
      invoicePrefix:     data.invoicePrefix || 'REC',
      autoSubmit:        data.autoSubmit || false,
      notifyEmail:       data.notifyEmail || null,
      isActive:          true,
      createdBy:         actor._id,
    });
    logger.info(`[invoice-scheduler] created schedule ${schedule._id} pattern=${data.recurrencePattern}`);
    return schedule;
  }

  async list(businessId, { isActive } = {}) {
    const filter = { businessId };
    if (isActive != null) filter.isActive = isActive;
    return InvoiceSchedule.find(filter)
      .populate('customerId', 'fullName businessName email')
      .sort({ nextRunDate: 1 })
      .lean();
  }

  async getById(id, businessId) {
    this._validateId(id, 'scheduleId');
    const s = await InvoiceSchedule.findOne({ _id: id, businessId })
      .populate('customerId', 'fullName businessName email')
      .lean();
    if (!s) throw new ApiError(404, 'Schedule not found');
    return s;
  }

  async update(id, businessId, data) {
    this._validateId(id, 'scheduleId');
    const allowed = [
      'name', 'description', 'endDate', 'lineItems', 'currencyCode',
      'paymentTermsCode', 'invoicePrefix', 'autoSubmit', 'notifyEmail', 'isActive',
    ];
    const update = {};
    for (const k of allowed) if (data[k] !== undefined) update[k] = data[k];
    const s = await InvoiceSchedule.findOneAndUpdate(
      { _id: id, businessId }, { $set: update }, { new: true }
    ).lean();
    if (!s) throw new ApiError(404, 'Schedule not found');
    return s;
  }

  async deactivate(id, businessId) {
    this._validateId(id, 'scheduleId');
    const s = await InvoiceSchedule.findOneAndUpdate(
      { _id: id, businessId }, { $set: { isActive: false } }, { new: true }
    ).lean();
    if (!s) throw new ApiError(404, 'Schedule not found');
    return s;
  }

  // ── Cron: generate due invoices ───────────────────────────────────────────
  /**
   * Find active schedules whose nextRunDate <= now, generate Invoice drafts,
   * then advance nextRunDate. Idempotent at the schedule level (nextRunDate +
   * runCount guard); a transient failure on one schedule never aborts the rest.
   * @returns {Promise<Array>} created Invoice _ids
   */
  async generateDueInvoices(actor = null) {
    const now = new Date();
    const schedules = await InvoiceSchedule.find({
      isActive: true,
      nextRunDate: { $lte: now },
      $or: [{ endDate: null }, { endDate: { $gte: now } }],
    }).lean();

    const created = [];
    for (const sched of schedules) {
      try {
        const invoice = await this._generateInvoiceFromSchedule(sched, actor);
        created.push(invoice._id);

        const next = this.computeNextRunDate(sched.recurrencePattern, sched.nextRunDate);
        await InvoiceSchedule.findByIdAndUpdate(sched._id, {
          $set: { nextRunDate: next, lastRunDate: now },
          $inc: { runCount: 1 },
        });

        businessEvents.emit(EVENTS.RECURRING_INVOICE_GENERATED, {
          businessId: String(sched.businessId),
          userId: actor?._id || sched.createdBy,
          entityType: ENTITY_TYPES.INVOICE, entityId: invoice._id,
          scheduleId: sched._id, invoiceNumber: invoice.invoiceNumber,
        });
      } catch (err) {
        // best-effort: one schedule's failure must not abort the whole cron run; remaining schedules still generate their invoices.
        logger.error(`[invoice-scheduler] failed to generate invoice from schedule ${sched._id}: ${err.message}`);
      }
    }
    logger.info(`[invoice-scheduler] generated ${created.length} invoices from ${schedules.length} schedules`);
    return created;
  }

  async _generateInvoiceFromSchedule(sched, actor) {
    const issueDate = new Date();
    const terms = paymentTermsUtil.buildSnapshot(sched.paymentTermsCode || 'NET_30');
    terms.discountDeadline = paymentTermsUtil.computeDiscountDeadline(issueDate, terms);
    const dueDate = paymentTermsUtil.computeDueDate(issueDate, terms);

    let amount = 0;
    for (const li of sched.lineItems || []) amount += (li.quantity || 0) * (li.unitPrice || 0);
    amount = r2(amount);

    const datePart = issueDate.toISOString().slice(0, 10).replace(/-/g, '');
    const invoiceNumber = `${sched.invoicePrefix || 'REC'}-${datePart}-${String(sched._id).slice(-6).toUpperCase()}`;

    // Snapshot the customer (name protection) when one is linked.
    let customerSnapshot = {};
    if (sched.customerId) {
      const c = await Customer.findById(sched.customerId).select('fullName businessName email phone taxId').lean();
      if (c) customerSnapshot = { fullName: c.fullName, businessName: c.businessName, email: c.email, phone: c.phone, taxId: c.taxId };
    }

    const invoice = await Invoice.create({
      businessId:   sched.businessId,
      invoiceNumber,
      customerId:   sched.customerId || null,
      customerSnapshot,
      issueDate,
      dueDate,
      paymentTerms: terms,
      lineItems:    sched.lineItems || [],
      amount:       (sched.lineItems || []).length ? 0.01 : amount, // pre-save recomputes from lines
      taxAmount:    0,
      currencyCode: sched.currencyCode || 'PKR',
      state:        sched.autoSubmit ? INVOICE_STATES.PENDING_APPROVAL : INVOICE_STATES.DRAFT,
      approvalStatus: sched.autoSubmit ? APPROVAL_STATUS.PENDING : APPROVAL_STATUS.NOT_REQUIRED,
      isRecurring:  true,
      recurringScheduleId: sched._id,
      createdBy:    actor?._id || sched.createdBy,
      lastModifiedBy: actor?._id || sched.createdBy,
      description:  `Auto-generated from recurring schedule: ${sched.name}`,
    });

    try {
      await auditService.log({
        businessId: sched.businessId, entityType: ENTITY_TYPES.INVOICE, entityId: invoice._id,
        action: AUDIT_ACTIONS.RECURRING_GENERATED,
        performedBy: actor?._id || sched.createdBy, performedByName: 'Recurring Scheduler',
        afterState: { invoiceNumber, scheduleId: sched._id },
      });
    } catch (e) {
      // best-effort: audit-log write is observability only; the generated invoice was already persisted.
      logger.warn(`[invoice-scheduler] audit failed: ${e.message}`);
    }

    logger.info(`[invoice-scheduler] generated invoice ${invoice._id} from schedule ${sched._id}`);
    return invoice;
  }
}

module.exports = new InvoiceSchedulerService();

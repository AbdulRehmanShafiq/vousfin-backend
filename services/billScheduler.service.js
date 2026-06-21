// services/billScheduler.service.js
//
// Phase 3.3 — Bill Scheduling, Recurring Bills & Reminders
//
// Responsibilities:
//   1. CRUD for BillSchedule documents
//   2. generateDueBills()  — called by a cron job; creates Bill docs from schedules
//   3. updateReminderStates() — scans approved/scheduled bills and sets reminderState
//   4. Helper: computeNextRunDate(pattern, from)
//
'use strict';
const mongoose = require('mongoose');
const BillSchedule = require('../models/BillSchedule.model');
const Bill         = require('../models/Bill.model');
const { ApiError } = require('../utils/ApiError');
const logger       = require('../config/logger');
const {
  RECURRENCE_PATTERNS,
  REMINDER_STATES,
  BILL_STATES,
} = require('../config/constants');

class BillSchedulerService {

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _validateId(id, label = 'id') {
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, `Invalid ${label}`);
    }
  }

  /**
   * Advance a date by one recurrence period.
   * @param {string} pattern — RECURRENCE_PATTERNS value
   * @param {Date}   from
   * @returns {Date}
   */
  computeNextRunDate(pattern, from) {
    const d = new Date(from);
    switch (pattern) {
      case RECURRENCE_PATTERNS.WEEKLY:    d.setDate(d.getDate() + 7);       break;
      case RECURRENCE_PATTERNS.BIWEEKLY:  d.setDate(d.getDate() + 14);      break;
      case RECURRENCE_PATTERNS.MONTHLY:   d.setMonth(d.getMonth() + 1);     break;
      case RECURRENCE_PATTERNS.QUARTERLY: d.setMonth(d.getMonth() + 3);     break;
      case RECURRENCE_PATTERNS.ANNUAL:    d.setFullYear(d.getFullYear() + 1);break;
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

    const startDate = new Date(data.startDate);
    const schedule  = await BillSchedule.create({
      businessId,
      vendorId:          data.vendorId    || null,
      name:              data.name,
      description:       data.description || null,
      recurrencePattern: data.recurrencePattern,
      startDate,
      endDate:           data.endDate ? new Date(data.endDate) : null,
      nextRunDate:       startDate,
      lineItems:         data.lineItems   || [],
      currencyCode:      data.currencyCode || 'PKR',
      paymentTermsDays:  data.paymentTermsDays != null ? data.paymentTermsDays : 30,
      autoSubmit:        data.autoSubmit  || false,
      notifyEmail:       data.notifyEmail || null,
      isActive:          true,
      createdBy:         actor._id,
    });

    logger.info(`[scheduler] created schedule ${schedule._id} pattern=${data.recurrencePattern}`);
    return schedule;
  }

  async list(businessId, { isActive } = {}) {
    const filter = { businessId };
    if (isActive != null) filter.isActive = isActive;
    return BillSchedule.find(filter)
      .populate('vendorId', 'vendorName email')
      .sort({ nextRunDate: 1 })
      .lean();
  }

  async getById(id, businessId) {
    this._validateId(id, 'scheduleId');
    const s = await BillSchedule.findOne({ _id: id, businessId })
      .populate('vendorId', 'vendorName email')
      .lean();
    if (!s) throw new ApiError(404, 'Schedule not found');
    return s;
  }

  async update(id, businessId, data) {
    this._validateId(id, 'scheduleId');
    const allowed = [
      'name', 'description', 'endDate', 'lineItems', 'currencyCode',
      'paymentTermsDays', 'autoSubmit', 'notifyEmail', 'isActive',
    ];
    const update = {};
    for (const k of allowed) {
      if (data[k] !== undefined) update[k] = data[k];
    }
    const s = await BillSchedule.findOneAndUpdate(
      { _id: id, businessId },
      { $set: update },
      { new: true }
    ).lean();
    if (!s) throw new ApiError(404, 'Schedule not found');
    return s;
  }

  async deactivate(id, businessId) {
    this._validateId(id, 'scheduleId');
    const s = await BillSchedule.findOneAndUpdate(
      { _id: id, businessId },
      { $set: { isActive: false } },
      { new: true }
    ).lean();
    if (!s) throw new ApiError(404, 'Schedule not found');
    return s;
  }

  // ── Cron: generate due bills ─────────────────────────────────────────────────

  /**
   * Find all active schedules whose nextRunDate <= now, generate Bill drafts,
   * then advance nextRunDate.  Should be called by a cron job (e.g., daily at 06:00).
   *
   * Returns array of created Bill _ids.
   */
  async generateDueBills(actor = null) {
    const now       = new Date();
    const schedules = await BillSchedule.find({
      isActive:    true,
      nextRunDate: { $lte: now },
      $or: [{ endDate: null }, { endDate: { $gte: now } }],
    }).lean();

    const created = [];
    for (const sched of schedules) {
      try {
        const bill = await this._generateBillFromSchedule(sched, actor);
        created.push(bill._id);

        // Advance nextRunDate
        const next = this.computeNextRunDate(sched.recurrencePattern, sched.nextRunDate);
        await BillSchedule.findByIdAndUpdate(sched._id, {
          $set: { nextRunDate: next, lastRunDate: now },
          $inc: { runCount: 1 },
        });

      } catch (err) {
        // best-effort: one schedule's failure must not abort the whole cron run; remaining schedules still generate their bills.
        logger.error(`[scheduler] failed to generate bill from schedule ${sched._id}: ${err.message}`);
      }
    }

    logger.info(`[scheduler] generated ${created.length} bills from ${schedules.length} schedules`);
    return created;
  }

  async _generateBillFromSchedule(sched, actor) {
    const issueDate = new Date();
    const dueDate   = new Date(issueDate);
    dueDate.setDate(dueDate.getDate() + (sched.paymentTermsDays || 30));

    // Compute totals from line items
    let amount = 0;
    for (const li of sched.lineItems || []) {
      amount += (li.quantity || 0) * (li.unitPrice || 0);
    }
    amount = Math.round(amount * 100) / 100;

    // Generate a unique bill number: SCH-YYYYMMDD-<scheduleId tail>
    const datePart = issueDate.toISOString().slice(0, 10).replace(/-/g, '');
    const billNumber = `SCH-${datePart}-${String(sched._id).slice(-6).toUpperCase()}`;

    const bill = await Bill.create({
      businessId:   sched.businessId,
      billNumber,
      vendorId:     sched.vendorId    || null,
      issueDate,
      dueDate,
      lineItems:    sched.lineItems   || [],
      amount,
      taxAmount:    0,
      totalAmount:  amount,
      currencyCode: sched.currencyCode || 'PKR',
      state:        sched.autoSubmit
                      ? BILL_STATES.AWAITING_APPROVAL
                      : BILL_STATES.DRAFT,
      isRecurring:  true,
      scheduleId:   sched._id,
      createdBy:    actor?._id || sched.createdBy,
      description:  `Auto-generated from schedule: ${sched.name}`,
    });

    logger.info(`[scheduler] generated bill ${bill._id} from schedule ${sched._id}`);
    return bill;
  }

  // ── Cron: update reminder states ─────────────────────────────────────────────

  /**
   * Scan all open bills (approved / scheduled / partially_paid) and compute
   * the correct reminderState based on dueDate vs today.
   * Should be called daily.
   *
   * Thresholds:
   *   upcoming         — 1–7 days before dueDate
   *   due_today        — same calendar day as dueDate
   *   overdue          — 1–30 days past dueDate
   *   critical_overdue — >30 days past dueDate
   */
  async updateReminderStates() {
    const now = new Date();
    const nowDateOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const openStates = [
      BILL_STATES.APPROVED,
      BILL_STATES.SCHEDULED,
      'partially_paid',
      BILL_STATES.OVERDUE,
    ];

    const bills = await Bill.find({
      state:    { $in: openStates },
      dueDate:  { $ne: null },
      isArchived: { $ne: true },
    }).select('_id dueDate reminderState');

    let updated = 0;
    for (const bill of bills) {
      const due        = new Date(bill.dueDate);
      const dueDateOnly = new Date(due.getFullYear(), due.getMonth(), due.getDate());
      const diffMs     = dueDateOnly.getTime() - nowDateOnly.getTime();
      const diffDays   = Math.round(diffMs / 86400000);  // positive = future

      let state = null;
      if (diffDays > 7)          state = null;               // too far out
      else if (diffDays >= 1)    state = REMINDER_STATES.UPCOMING;
      else if (diffDays === 0)   state = REMINDER_STATES.DUE_TODAY;
      else if (diffDays >= -30)  state = REMINDER_STATES.OVERDUE;
      else                       state = REMINDER_STATES.CRITICAL_OVERDUE;

      if (state !== bill.reminderState) {
        await Bill.updateOne({ _id: bill._id }, { $set: { reminderState: state } });
        updated++;
      }
    }

    logger.info(`[scheduler] updateReminderStates: updated ${updated} of ${bills.length} bills`);
    return { total: bills.length, updated };
  }

  // ── Query helpers ────────────────────────────────────────────────────────────

  /**
   * Return bill counts grouped by reminderState for a business.
   * Used by the AP dashboard.
   */
  async getReminderSummary(businessId) {
    const rows = await Bill.aggregate([
      {
        $match: {
          businessId: new mongoose.Types.ObjectId(businessId),
          reminderState: { $ne: null },
          isArchived: { $ne: true },
        },
      },
      { $group: { _id: '$reminderState', count: { $sum: 1 }, totalAmount: { $sum: '$totalAmount' } } },
    ]);
    const out = {};
    for (const r of rows) out[r._id] = { count: r.count, totalAmount: r.totalAmount };
    return out;
  }
}

module.exports = new BillSchedulerService();

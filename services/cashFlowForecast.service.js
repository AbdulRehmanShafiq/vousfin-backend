// services/cashFlowForecast.service.js
//
// Phase 3.4 — Cash Flow Impact Engine (AP side)
//
// Forecasts payable cash requirements based on open bills.
// Uses pure MongoDB aggregation — no JS-side accumulation.
//
// Methods:
//   payableObligations(businessId, { horizonDays })
//     → weekly payment schedule for next N days
//
//   cashRequirements(businessId)
//     → 30 / 60 / 90-day rolling payable totals
//
//   upcomingDueBills(businessId, { days, page, limit })
//     → paginated list of bills due within N days
//
//   dashboardForecast(businessId)
//     → merged object for dashboard AP cash panel
//
'use strict';
const mongoose    = require('mongoose');
const Bill        = require('../models/Bill.model');
const { ApiError } = require('../utils/ApiError');
const reportCache  = require('../utils/reportCache');
const logger       = require('../config/logger');

const OID = (id) => new mongoose.Types.ObjectId(id);

class CashFlowForecastService {

  _validateId(id, label = 'businessId') {
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, `Invalid ${label}`);
    }
  }

  // ── 1. Payable Obligations — weekly breakdown ──────────────────────────────

  /**
   * Groups open payables by week bucket within the forecast horizon.
   * Returns an array of { weekLabel, weekStart, weekEnd, amount, billCount }.
   */
  async payableObligations(businessId, { horizonDays = 90 } = {}) {
    this._validateId(businessId);
    const cacheKey = { type: 'payable-obligations', horizonDays };
    const cached = await reportCache.get('ap-forecast', businessId, cacheKey);
    if (cached) return cached;

    const now    = new Date();
    const cutoff = new Date(now.getTime() + horizonDays * 86400000);

    const pipeline = [
      {
        $match: {
          businessId: OID(businessId),
          isArchived: { $ne: true },
          state: { $in: ['approved', 'scheduled', 'partially_paid'] },
          dueDate: { $gte: now, $lte: cutoff },
          remainingBalance: { $gt: 0 },
        },
      },
      {
        $project: {
          remainingBalance: 1,
          dueDate: 1,
          vendorName: '$vendorSnapshot.vendorName',
          // Days from now until due
          daysUntilDue: {
            $divide: [{ $subtract: ['$dueDate', now] }, 86400000],
          },
        },
      },
      {
        $bucket: {
          groupBy: '$daysUntilDue',
          boundaries: [0, 8, 15, 22, 31, 61],
          default: '61_plus',
          output: {
            amount:    { $sum: '$remainingBalance' },
            billCount: { $sum: 1 },
          },
        },
      },
    ];

    const raw = await Bill.aggregate(pipeline);

    const WEEK_LABELS = {
      0:        'This week (1–7d)',
      8:        'Next week (8–14d)',
      15:       'Week 3 (15–21d)',
      22:       'Week 4 (22–30d)',
      31:       '31–60 days',
      '61_plus': '60+ days',
    };

    const result = raw.map(b => ({
      bucket:    WEEK_LABELS[b._id] ?? String(b._id),
      amount:    Math.round(b.amount * 100) / 100,
      billCount: b.billCount,
    }));

    reportCache.set('ap-forecast', businessId, cacheKey, result);
    return result;
  }

  // ── 2. Cash Requirements — 30/60/90 rolling totals ─────────────────────────

  /**
   * How much cash is needed to clear all open payables in the next 30/60/90 days.
   */
  async cashRequirements(businessId) {
    this._validateId(businessId);
    const cached = await reportCache.get('ap-forecast', businessId, { type: 'cash-requirements' });
    if (cached) return cached;

    const now = new Date();
    const d30  = new Date(now.getTime() + 30  * 86400000);
    const d60  = new Date(now.getTime() + 60  * 86400000);
    const d90  = new Date(now.getTime() + 90  * 86400000);

    const openFilter = {
      businessId: OID(businessId),
      isArchived: { $ne: true },
      state: { $in: ['approved', 'scheduled', 'partially_paid'] },
      remainingBalance: { $gt: 0 },
    };

    const [r30, r60, r90, overdue] = await Promise.all([
      Bill.aggregate([
        { $match: { ...openFilter, dueDate: { $lte: d30 } } },
        { $group: { _id: null, amount: { $sum: '$remainingBalance' }, count: { $sum: 1 } } },
      ]),
      Bill.aggregate([
        { $match: { ...openFilter, dueDate: { $lte: d60 } } },
        { $group: { _id: null, amount: { $sum: '$remainingBalance' }, count: { $sum: 1 } } },
      ]),
      Bill.aggregate([
        { $match: { ...openFilter, dueDate: { $lte: d90 } } },
        { $group: { _id: null, amount: { $sum: '$remainingBalance' }, count: { $sum: 1 } } },
      ]),
      // Already overdue
      Bill.aggregate([
        {
          $match: {
            ...openFilter,
            dueDate: { $lt: now },
          },
        },
        { $group: { _id: null, amount: { $sum: '$remainingBalance' }, count: { $sum: 1 } } },
      ]),
    ]);

    const pick = (arr) => arr[0] ? { amount: Math.round(arr[0].amount * 100) / 100, count: arr[0].count } : { amount: 0, count: 0 };

    const result = {
      overdue:   pick(overdue),
      next30:    pick(r30),
      next60:    pick(r60),
      next90:    pick(r90),
      asOf:      now.toISOString(),
    };

    reportCache.set('ap-forecast', businessId, { type: 'cash-requirements' }, result);
    return result;
  }

  // ── 3. Upcoming Due Bills — paginated ──────────────────────────────────────

  /**
   * Paginated list of bills due within the next N days.
   * Sorted by dueDate ascending (most urgent first).
   */
  async upcomingDueBills(businessId, { days = 14, page = 1, limit = 20 } = {}) {
    this._validateId(businessId);
    const now    = new Date();
    const cutoff = new Date(now.getTime() + days * 86400000);
    const skip   = (page - 1) * limit;

    const filter = {
      businessId: OID(businessId),
      isArchived: { $ne: true },
      state: { $in: ['approved', 'scheduled', 'partially_paid'] },
      dueDate: { $gte: now, $lte: cutoff },
      remainingBalance: { $gt: 0 },
    };

    const [docs, total] = await Promise.all([
      Bill.find(filter)
        .select('billNumber vendorSnapshot dueDate remainingBalance totalAmount state reminderState')
        .sort({ dueDate: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Bill.countDocuments(filter),
    ]);

    return {
      docs,
      total,
      page,
      pages: Math.ceil(total / limit),
    };
  }

  // ── 4. Dashboard Forecast Panel ────────────────────────────────────────────

  /**
   * Single call for the AP cash panel on the main dashboard.
   * Returns cash requirements + obligations + a 5-bill urgent preview.
   */
  async dashboardForecast(businessId) {
    this._validateId(businessId);
    const cacheKey = { type: 'dashboard-forecast' };
    const cached = await reportCache.get('ap-forecast', businessId, cacheKey);
    if (cached) return cached;

    const [requirements, obligations, urgent] = await Promise.all([
      this.cashRequirements(businessId),
      this.payableObligations(businessId, { horizonDays: 30 }),
      this.upcomingDueBills(businessId, { days: 7, limit: 5 }),
    ]);

    const result = { requirements, obligations, urgentBills: urgent.docs };
    reportCache.set('ap-forecast', businessId, cacheKey, result, 60 * 1000); // 1-min TTL
    logger.info(`[cashflow-forecast] dashboardForecast computed for ${businessId}`);
    return result;
  }
}

module.exports = new CashFlowForecastService();

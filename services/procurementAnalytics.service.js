// services/procurementAnalytics.service.js
//
// Phase 3.4 — Procurement Analytics Engine
//
// All metrics use MongoDB aggregation pipelines — zero JS-side grouping.
// Results are cached via reportCache (30-second TTL, business-scoped).
//
// Endpoints:
//   vendorSpendAnalysis   — top vendors by spend, by category
//   cycleTimeAnalysis     — PO→GRN, PO→Bill, Bill→Payment avg days
//   overdueStats          — overdue amounts by severity bucket
//   paymentBehaviorStats  — on-time vs late payment rates
//   recurringExpenses     — recurring vs ad-hoc split
//   purchasingEfficiency  — PO-backed vs ad-hoc bill rate
//   fullAnalytics         — all of the above in one call
//
'use strict';
const mongoose   = require('mongoose');
const Bill       = require('../models/Bill.model');
const PurchaseOrder = require('../models/PurchaseOrder.model');
const { ApiError } = require('../utils/ApiError');
const reportCache  = require('../utils/reportCache');
const logger       = require('../config/logger');

const OID = (id) => new mongoose.Types.ObjectId(id);

class ProcurementAnalyticsService {

  _validateId(id, label = 'businessId') {
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, `Invalid ${label}`);
    }
  }

  _monthsAgo(n) {
    const d = new Date();
    d.setMonth(d.getMonth() - n);
    return d;
  }

  // ── 1. Vendor Spend Analysis ──────────────────────────────────────────────────

  /**
   * Returns top vendors by total bill spend + spend breakdown per vendor.
   * @param {string} businessId
   * @param {{ months?: number, limit?: number }} opts
   */
  async vendorSpendAnalysis(businessId, { months = 12, limit = 10 } = {}) {
    this._validateId(businessId);
    const cacheKey = { type: 'vendor-spend', months, limit };
    const cached = await reportCache.get('procurement', businessId, cacheKey);
    if (cached) return cached;

    const since = this._monthsAgo(months);

    const pipeline = [
      {
        $match: {
          businessId: OID(businessId),
          isArchived: { $ne: true },
          issueDate: { $gte: since },
        },
      },
      {
        $group: {
          _id: '$vendorId',
          vendorName:   { $first: '$vendorSnapshot.vendorName' },
          totalSpend:   { $sum: '$totalAmount' },
          billCount:    { $sum: 1 },
          paidAmount:   { $sum: '$paidAmount' },
          outstanding:  { $sum: '$remainingBalance' },
          avgBillValue: { $avg: '$totalAmount' },
          lastBillDate: { $max: '$issueDate' },
        },
      },
      { $sort: { totalSpend: -1 } },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          vendorId:     '$_id',
          vendorName:   1,
          totalSpend:   { $round: ['$totalSpend', 2] },
          billCount:    1,
          paidAmount:   { $round: ['$paidAmount', 2] },
          outstanding:  { $round: ['$outstanding', 2] },
          avgBillValue: { $round: ['$avgBillValue', 2] },
          lastBillDate: 1,
        },
      },
    ];

    const rows = await Bill.aggregate(pipeline);

    // Compute grand totals for share %
    const grandTotal = rows.reduce((s, r) => s + r.totalSpend, 0);
    const topVendors = rows.map(r => ({
      ...r,
      sharePercent: grandTotal > 0 ? Math.round((r.totalSpend / grandTotal) * 1000) / 10 : 0,
    }));

    // Category spend (group by first line-item account name — best-effort)
    const catPipeline = [
      {
        $match: {
          businessId: OID(businessId),
          isArchived: { $ne: true },
          issueDate: { $gte: since },
        },
      },
      { $unwind: { path: '$lineItems', preserveNullAndEmpty: false } },
      {
        $group: {
          _id: { $ifNull: ['$lineItems.name', 'Uncategorized'] },
          totalSpend: { $sum: '$lineItems.lineTotal' },
          billCount:  { $sum: 1 },
        },
      },
      { $sort: { totalSpend: -1 } },
      { $limit: 8 },
      {
        $project: {
          _id: 0,
          category:   '$_id',
          totalSpend: { $round: ['$totalSpend', 2] },
          billCount:  1,
        },
      },
    ];
    const categoryBreakdown = await Bill.aggregate(catPipeline);

    const result = {
      topVendors,
      categoryBreakdown,
      grandTotal: Math.round(grandTotal * 100) / 100,
      periodMonths: months,
    };

    reportCache.set('procurement', businessId, cacheKey, result);
    return result;
  }

  // ── 2. Cycle Time Analysis ────────────────────────────────────────────────────

  /**
   * Computes average days for each procurement stage:
   *   PO issue → first GRN receipt
   *   PO issue → Bill issue
   *   Bill issue → Bill paid
   */
  async cycleTimeAnalysis(businessId, { months = 6 } = {}) {
    this._validateId(businessId);
    const cacheKey = { type: 'cycle-time', months };
    const cached = await reportCache.get('procurement', businessId, cacheKey);
    if (cached) return cached;

    const since = this._monthsAgo(months);
    const MS_PER_DAY = 86400000;

    // Bills paid in period — compute bill-to-payment cycle
    const billCyclePipeline = [
      {
        $match: {
          businessId: OID(businessId),
          state: 'paid',
          isArchived: { $ne: true },
          issueDate: { $gte: since },
          paidAt: { $ne: null },
        },
      },
      {
        $project: {
          billToPay: {
            $divide: [
              { $subtract: ['$paidAt', '$issueDate'] },
              MS_PER_DAY,
            ],
          },
          billToDue: {
            $cond: {
              if: { $ne: ['$dueDate', null] },
              then: { $divide: [{ $subtract: ['$dueDate', '$issueDate'] }, MS_PER_DAY] },
              else: null,
            },
          },
          onTime: {
            $cond: {
              if: { $and: [{ $ne: ['$paidAt', null] }, { $ne: ['$dueDate', null] }] },
              then: { $lte: ['$paidAt', '$dueDate'] },
              else: null,
            },
          },
        },
      },
      {
        $group: {
          _id: null,
          avgBillToPayDays: { $avg: '$billToPay' },
          avgPaymentTermDays: { $avg: '$billToDue' },
          onTimeCount:  { $sum: { $cond: ['$onTime', 1, 0] } },
          lateCount:    { $sum: { $cond: [{ $eq: ['$onTime', false] }, 1, 0] } },
          totalPaid:    { $sum: 1 },
        },
      },
    ];

    // PO-to-Bill cycle — bills with a linked PO
    const poCyclePipeline = [
      {
        $match: {
          businessId: OID(businessId),
          purchaseOrderId: { $ne: null },
          isArchived: { $ne: true },
          issueDate: { $gte: since },
        },
      },
      {
        $lookup: {
          from: 'purchaseorders',
          localField: 'purchaseOrderId',
          foreignField: '_id',
          as: 'po',
        },
      },
      { $unwind: { path: '$po', preserveNullAndEmpty: false } },
      {
        $project: {
          poToBillDays: {
            $divide: [
              { $subtract: ['$issueDate', '$po.createdAt'] },
              MS_PER_DAY,
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          avgPoToBillDays: { $avg: '$poToBillDays' },
          count: { $sum: 1 },
        },
      },
    ];

    const [billCycle = [{}], poCycle = [{}]] = await Promise.all([
      Bill.aggregate(billCyclePipeline),
      Bill.aggregate(poCyclePipeline),
    ]);

    const bc = billCycle[0] || {};
    const pc = poCycle[0]   || {};

    const round1 = (v) => v != null ? Math.round(v * 10) / 10 : null;

    const result = {
      avgBillToPayDays:    round1(bc.avgBillToPayDays),
      avgPaymentTermDays:  round1(bc.avgPaymentTermDays),
      avgPoToBillDays:     round1(pc.avgPoToBillDays),
      onTimePayments:      bc.onTimeCount || 0,
      latePayments:        bc.lateCount   || 0,
      totalPaidBills:      bc.totalPaid   || 0,
      onTimeRate: bc.totalPaid > 0
        ? Math.round((bc.onTimeCount / bc.totalPaid) * 1000) / 10
        : null,
      periodMonths: months,
    };

    reportCache.set('procurement', businessId, cacheKey, result);
    return result;
  }

  // ── 3. Overdue Stats ──────────────────────────────────────────────────────────

  /**
   * Counts and sums overdue bills by severity bucket.
   */
  async overdueStats(businessId) {
    this._validateId(businessId);
    const cached = await reportCache.get('procurement', businessId, { type: 'overdue-stats' });
    if (cached) return cached;

    const now = new Date();

    const pipeline = [
      {
        $match: {
          businessId: OID(businessId),
          isArchived: { $ne: true },
          state: { $in: ['approved', 'scheduled', 'partially_paid', 'overdue'] },
          dueDate: { $lt: now },
          remainingBalance: { $gt: 0 },
        },
      },
      {
        $project: {
          daysOverdue: {
            $divide: [{ $subtract: [now, '$dueDate'] }, 86400000],
          },
          remainingBalance: 1,
          vendorId: 1,
          vendorSnapshot: 1,
        },
      },
      {
        $bucket: {
          groupBy: '$daysOverdue',
          boundaries: [0, 31, 61, 91],
          default: '90_plus',
          output: {
            count:   { $sum: 1 },
            amount:  { $sum: '$remainingBalance' },
          },
        },
      },
    ];

    const buckets = await Bill.aggregate(pipeline);

    // Normalize bucket ids
    const labels = { 0: '1_30', 31: '31_60', 61: '61_90', '90_plus': '90_plus' };
    const result = {
      buckets: {},
      totalOverdueAmount: 0,
      totalOverdueCount:  0,
    };
    for (const b of buckets) {
      const key = labels[b._id] ?? String(b._id);
      result.buckets[key] = {
        count:  b.count,
        amount: Math.round(b.amount * 100) / 100,
      };
      result.totalOverdueAmount += b.amount;
      result.totalOverdueCount  += b.count;
    }
    result.totalOverdueAmount = Math.round(result.totalOverdueAmount * 100) / 100;

    reportCache.set('procurement', businessId, { type: 'overdue-stats' }, result);
    return result;
  }

  // ── 4. Payment Behavior Stats ─────────────────────────────────────────────────

  /**
   * Aggregates on-time / early / late payment percentages month-by-month.
   */
  async paymentBehaviorStats(businessId, { months = 6 } = {}) {
    this._validateId(businessId);
    const cacheKey = { type: 'payment-behavior', months };
    const cached = await reportCache.get('procurement', businessId, cacheKey);
    if (cached) return cached;

    const since = this._monthsAgo(months);

    const pipeline = [
      {
        $match: {
          businessId: OID(businessId),
          state: 'paid',
          isArchived: { $ne: true },
          paidAt: { $gte: since, $ne: null },
          dueDate: { $ne: null },
        },
      },
      {
        $project: {
          month: { $dateToString: { format: '%Y-%m', date: '$paidAt' } },
          paymentStatus: {
            $switch: {
              branches: [
                { case: { $lt: ['$paidAt', '$dueDate'] }, then: 'early' },
                { case: { $eq: [{ $dateToString: { format: '%Y-%m-%d', date: '$paidAt' } },
                                  { $dateToString: { format: '%Y-%m-%d', date: '$dueDate' } }] }, then: 'on_time' },
              ],
              default: 'late',
            },
          },
          totalAmount: 1,
        },
      },
      {
        $group: {
          _id: { month: '$month', status: '$paymentStatus' },
          count:  { $sum: 1 },
          amount: { $sum: '$totalAmount' },
        },
      },
      { $sort: { '_id.month': 1 } },
    ];

    const rows = await Bill.aggregate(pipeline);

    // Re-shape into { month, early, on_time, late }
    const byMonth = {};
    for (const r of rows) {
      const m = r._id.month;
      if (!byMonth[m]) byMonth[m] = { month: m, early: 0, on_time: 0, late: 0, total: 0 };
      byMonth[m][r._id.status] += r.count;
      byMonth[m].total += r.count;
    }
    const timeline = Object.values(byMonth).map(m => ({
      ...m,
      onTimeRate: m.total > 0 ? Math.round(((m.early + m.on_time) / m.total) * 1000) / 10 : null,
    }));

    reportCache.set('procurement', businessId, cacheKey, timeline);
    return timeline;
  }

  // ── 5. Recurring Expenses ─────────────────────────────────────────────────────

  /**
   * Splits total spend into recurring vs ad-hoc, month by month.
   */
  async recurringExpenses(businessId, { months = 6 } = {}) {
    this._validateId(businessId);
    const cacheKey = { type: 'recurring-expenses', months };
    const cached = await reportCache.get('procurement', businessId, cacheKey);
    if (cached) return cached;

    const since = this._monthsAgo(months);

    const pipeline = [
      {
        $match: {
          businessId: OID(businessId),
          isArchived: { $ne: true },
          issueDate: { $gte: since },
        },
      },
      {
        $group: {
          _id: {
            month:     { $dateToString: { format: '%Y-%m', date: '$issueDate' } },
            recurring: '$isRecurring',
          },
          totalAmount: { $sum: '$totalAmount' },
          count:       { $sum: 1 },
        },
      },
      { $sort: { '_id.month': 1 } },
    ];

    const rows = await Bill.aggregate(pipeline);

    const byMonth = {};
    for (const r of rows) {
      const m = r._id.month;
      if (!byMonth[m]) byMonth[m] = { month: m, recurring: 0, adHoc: 0, total: 0, recurringCount: 0, adHocCount: 0 };
      if (r._id.recurring) {
        byMonth[m].recurring      += r.totalAmount;
        byMonth[m].recurringCount += r.count;
      } else {
        byMonth[m].adHoc      += r.totalAmount;
        byMonth[m].adHocCount += r.count;
      }
      byMonth[m].total += r.totalAmount;
    }

    const result = Object.values(byMonth).map(m => ({
      ...m,
      recurring:       Math.round(m.recurring * 100) / 100,
      adHoc:           Math.round(m.adHoc * 100) / 100,
      total:           Math.round(m.total * 100) / 100,
      recurringShare:  m.total > 0 ? Math.round((m.recurring / m.total) * 1000) / 10 : 0,
    }));

    reportCache.set('procurement', businessId, cacheKey, result);
    return result;
  }

  // ── 6. Purchasing Efficiency ──────────────────────────────────────────────────

  /**
   * Measures what % of bills are PO-backed vs ad-hoc.
   * Also measures average 3-way match pass rate.
   */
  async purchasingEfficiency(businessId, { months = 6 } = {}) {
    this._validateId(businessId);
    const cacheKey = { type: 'purchasing-efficiency', months };
    const cached = await reportCache.get('procurement', businessId, cacheKey);
    if (cached) return cached;

    const since = this._monthsAgo(months);

    const pipeline = [
      {
        $match: {
          businessId: OID(businessId),
          isArchived: { $ne: true },
          issueDate: { $gte: since },
        },
      },
      {
        $group: {
          _id: null,
          total:          { $sum: 1 },
          poBacked:       { $sum: { $cond: [{ $ne: ['$purchaseOrderId', null] }, 1, 0] } },
          matched:        { $sum: { $cond: [{ $eq: ['$threeWayMatchStatus', 'matched'] }, 1, 0] } },
          matchIssues:    { $sum: { $cond: [{ $in: ['$threeWayMatchStatus', ['over_billed', 'mismatch', 'blocked']] }, 1, 0] } },
          totalSpend:     { $sum: '$totalAmount' },
          poBackedSpend:  { $sum: {
            $cond: [{ $ne: ['$purchaseOrderId', null] }, '$totalAmount', 0],
          }},
        },
      },
    ];

    const [row = {}] = await Bill.aggregate(pipeline);
    const total = row.total || 0;

    const result = {
      totalBills:          total,
      poBackedBills:       row.poBacked  || 0,
      adHocBills:          total - (row.poBacked || 0),
      poBackedRate:        total > 0 ? Math.round(((row.poBacked || 0) / total) * 1000) / 10 : null,
      matchedBills:        row.matched   || 0,
      matchIssues:         row.matchIssues || 0,
      matchPassRate:       row.poBacked > 0 ? Math.round(((row.matched || 0) / row.poBacked) * 1000) / 10 : null,
      totalSpend:          Math.round((row.totalSpend || 0) * 100) / 100,
      poBackedSpend:       Math.round((row.poBackedSpend || 0) * 100) / 100,
      periodMonths: months,
    };

    reportCache.set('procurement', businessId, cacheKey, result);
    return result;
  }

  // ── 7. Full Analytics Bundle ──────────────────────────────────────────────────

  /**
   * Returns all analytics in one call (parallelized).
   */
  async fullAnalytics(businessId, params = {}) {
    this._validateId(businessId);
    const [
      spend,
      cycleTime,
      overdue,
      paymentBehavior,
      recurring,
      efficiency,
    ] = await Promise.all([
      this.vendorSpendAnalysis(businessId, params),
      this.cycleTimeAnalysis(businessId, params),
      this.overdueStats(businessId),
      this.paymentBehaviorStats(businessId, params),
      this.recurringExpenses(businessId, params),
      this.purchasingEfficiency(businessId, params),
    ]);

    logger.info(`[analytics] fullAnalytics computed for business ${businessId}`);
    return { spend, cycleTime, overdue, paymentBehavior, recurring, efficiency };
  }
}

module.exports = new ProcurementAnalyticsService();

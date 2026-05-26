/**
 * Financial Intelligence Service — Phase 4 Step 6
 *
 * Produces three advisory signal groups for a business:
 *
 *  1. unusualSpending  — categories with spending >1.5× their 3-month average
 *  2. taxRisk          — unremitted GST, overdue AR/AP, estimated tax liability
 *  3. cashFlowWarnings — cash runway, consecutive loss months, declining revenue
 *
 * All queries are businessId-scoped MongoDB aggregations (no full collection scans).
 * Every signal has: id, level ('info'|'warning'|'critical'), title, message.
 */

'use strict';

const mongoose    = require('mongoose');
const JournalEntry = require('../models/JournalEntry.model');
const { TRANSACTION_TYPES, JOURNAL_STATUS } = require('../config/constants');
const logger = require('../config/logger');

const POSTED_STATUSES = [
  JOURNAL_STATUS.POSTED,
  JOURNAL_STATUS.PARTIALLY_SETTLED,
  JOURNAL_STATUS.SETTLED,
];

function _validId(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id;
}

/* ════════════════════════════════════════════════════════════════════════════
   1. UNUSUAL SPENDING DETECTION
   Compares current month's expenses by transaction type vs. prior 3-month avg.
════════════════════════════════════════════════════════════════════════════ */
async function _unusualSpending(businessId) {
  const signals = [];
  const now = new Date();
  const bizId = _validId(businessId);

  // Current month boundaries
  const curStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const curEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  // Prior 3 months
  const priorEnd   = new Date(curStart.getTime() - 1);
  const priorStart = new Date(priorEnd.getFullYear(), priorEnd.getMonth() - 2, 1);

  const EXPENSE_TYPES = [
    TRANSACTION_TYPES.EXPENSE,
    TRANSACTION_TYPES.CASH_PURCHASE,
    TRANSACTION_TYPES.CREDIT_PURCHASE,
    TRANSACTION_TYPES.INVENTORY_PURCHASE,
    TRANSACTION_TYPES.SALARY,
  ];

  const [curRows, priorRows] = await Promise.all([
    JournalEntry.aggregate([
      {
        $match: {
          businessId: bizId,
          transactionDate: { $gte: curStart, $lte: curEnd },
          transactionType: { $in: EXPENSE_TYPES },
          status: { $in: POSTED_STATUSES },
          isArchived: { $ne: true },
        },
      },
      { $group: { _id: '$transactionType', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    JournalEntry.aggregate([
      {
        $match: {
          businessId: bizId,
          transactionDate: { $gte: priorStart, $lte: priorEnd },
          transactionType: { $in: EXPENSE_TYPES },
          status: { $in: POSTED_STATUSES },
          isArchived: { $ne: true },
        },
      },
      { $group: { _id: '$transactionType', total: { $sum: '$amount' } } },
    ]),
  ]);

  const priorMap = new Map(priorRows.map(r => [r._id, r.total / 3])); // per-month avg

  for (const cur of curRows) {
    const avg = priorMap.get(cur._id) || 0;
    if (avg === 0) continue; // no historical baseline — skip
    const ratio = cur.total / avg;
    if (ratio >= 2.0) {
      signals.push({
        id: `unusual_spending_${cur._id?.toLowerCase?.().replace(/\s+/g, '_') || 'expense'}`,
        level: 'critical',
        title: `${cur._id} Spending Spike`,
        message: `${cur._id} this month (${_fmt(cur.total)}) is ${Math.round(ratio)}× the 3-month average (${_fmt(avg)}). Review for errors or budget overruns.`,
      });
    } else if (ratio >= 1.5) {
      signals.push({
        id: `elevated_spending_${cur._id?.toLowerCase?.().replace(/\s+/g, '_') || 'expense'}`,
        level: 'warning',
        title: `Elevated ${cur._id}`,
        message: `${cur._id} this month (${_fmt(cur.total)}) is ${Math.round(ratio * 10) / 10}× above the 3-month average (${_fmt(avg)}).`,
      });
    }
  }

  return signals;
}

/* ════════════════════════════════════════════════════════════════════════════
   2. TAX RISK ANALYSIS
   Checks unremitted GST, overdue AR/AP, and estimated tax liability.
════════════════════════════════════════════════════════════════════════════ */
async function _taxRisk(businessId) {
  const signals = [];
  const bizId   = _validId(businessId);
  const now     = new Date();

  // Unremitted GST: GST_COLLECTION transactions without a matching GST_PAYMENT
  const [gstCollected, gstPaid] = await Promise.all([
    JournalEntry.aggregate([
      {
        $match: {
          businessId: bizId,
          transactionType: TRANSACTION_TYPES.GST_COLLECTION,
          status: { $in: POSTED_STATUSES },
          isArchived: { $ne: true },
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    JournalEntry.aggregate([
      {
        $match: {
          businessId: bizId,
          transactionType: TRANSACTION_TYPES.GST_PAYMENT,
          status: { $in: POSTED_STATUSES },
          isArchived: { $ne: true },
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);

  const collected = gstCollected[0]?.total || 0;
  const paid      = gstPaid[0]?.total     || 0;
  const unremitted = Math.max(0, collected - paid);

  if (unremitted > 0) {
    signals.push({
      id: 'unremitted_gst',
      level: unremitted > 50000 ? 'critical' : 'warning',
      title: 'Unremitted GST Balance',
      message: `${_fmt(unremitted)} in GST collected but not yet remitted to tax authority. Ensure timely filing to avoid penalties.`,
    });
  }

  // Overdue AR: outstanding receivables past due date
  const overdueAR = await JournalEntry.aggregate([
    {
      $match: {
        businessId: bizId,
        paymentType: 'receivable',
        paymentStatus: { $in: ['pending', 'partial'] },
        dueDate: { $lt: now },
        isArchived: { $ne: true },
      },
    },
    { $group: { _id: null, total: { $sum: '$remainingBalance' }, count: { $sum: 1 } } },
  ]);

  const arTotal = overdueAR[0]?.total || 0;
  const arCount = overdueAR[0]?.count || 0;
  if (arTotal > 0) {
    signals.push({
      id: 'overdue_receivables',
      level: arTotal > 200000 ? 'critical' : 'warning',
      title: `${arCount} Overdue Receivable${arCount > 1 ? 's' : ''}`,
      message: `${_fmt(arTotal)} in accounts receivable is past due. Follow up with customers to protect cash flow.`,
    });
  }

  // Overdue AP: outstanding payables past due
  const overdueAP = await JournalEntry.aggregate([
    {
      $match: {
        businessId: bizId,
        paymentType: 'payable',
        paymentStatus: { $in: ['pending', 'partial'] },
        dueDate: { $lt: now },
        isArchived: { $ne: true },
      },
    },
    { $group: { _id: null, total: { $sum: '$remainingBalance' }, count: { $sum: 1 } } },
  ]);

  const apTotal = overdueAP[0]?.total || 0;
  const apCount = overdueAP[0]?.count || 0;
  if (apTotal > 0) {
    signals.push({
      id: 'overdue_payables',
      level: 'warning',
      title: `${apCount} Overdue Payable${apCount > 1 ? 's' : ''}`,
      message: `${_fmt(apTotal)} in accounts payable is past due. Late payments may damage vendor relationships or incur fees.`,
    });
  }

  return signals;
}

/* ════════════════════════════════════════════════════════════════════════════
   3. CASH FLOW WARNINGS
   Analyzes last 6 months of monthly revenue/expense data for risk patterns.
════════════════════════════════════════════════════════════════════════════ */
async function _cashFlowWarnings(businessId) {
  const signals = [];
  const bizId   = _validId(businessId);
  const now     = new Date();

  const startDate = new Date(now.getFullYear(), now.getMonth() - 5, 1); // 6 months back

  const REVENUE_TYPES = [
    TRANSACTION_TYPES.INCOME, TRANSACTION_TYPES.CASH_SALE,
    TRANSACTION_TYPES.CREDIT_SALE, TRANSACTION_TYPES.INVENTORY_SALE,
  ];
  const EXPENSE_TYPES = [
    TRANSACTION_TYPES.EXPENSE, TRANSACTION_TYPES.CASH_PURCHASE,
    TRANSACTION_TYPES.CREDIT_PURCHASE, TRANSACTION_TYPES.INVENTORY_PURCHASE,
    TRANSACTION_TYPES.SALARY,
  ];

  const rows = await JournalEntry.aggregate([
    {
      $match: {
        businessId: bizId,
        transactionDate: { $gte: startDate },
        status: { $in: POSTED_STATUSES },
        isArchived: { $ne: true },
      },
    },
    {
      $group: {
        _id: { year: { $year: '$transactionDate' }, month: { $month: '$transactionDate' } },
        revenue:  { $sum: { $cond: [{ $in: ['$transactionType', REVENUE_TYPES] }, '$amount', 0] } },
        expenses: { $sum: { $cond: [{ $in: ['$transactionType', EXPENSE_TYPES] }, '$amount', 0] } },
      },
    },
    { $sort: { '_id.year': 1, '_id.month': 1 } },
  ]);

  if (rows.length < 2) return signals; // not enough data for trend analysis

  // Detect consecutive loss months (expenses > revenue)
  let consecutiveLoss = 0;
  let maxConsecutiveLoss = 0;
  for (const r of rows) {
    if (r.expenses > r.revenue) {
      consecutiveLoss++;
      maxConsecutiveLoss = Math.max(maxConsecutiveLoss, consecutiveLoss);
    } else {
      consecutiveLoss = 0;
    }
  }

  if (maxConsecutiveLoss >= 3) {
    signals.push({
      id: 'consecutive_losses',
      level: 'critical',
      title: `${maxConsecutiveLoss} Consecutive Loss Months`,
      message: `Business has been operating at a loss for ${maxConsecutiveLoss} consecutive months. Immediate cost review recommended.`,
    });
  } else if (maxConsecutiveLoss === 2) {
    signals.push({
      id: 'back_to_back_losses',
      level: 'warning',
      title: '2 Consecutive Loss Months',
      message: 'Expenses exceeded revenue for 2 consecutive months. Monitor closely and review cost structure.',
    });
  }

  // Detect declining revenue trend (last 3 months each lower than the previous)
  if (rows.length >= 3) {
    const last3 = rows.slice(-3);
    const declining = last3[0].revenue > last3[1].revenue && last3[1].revenue > last3[2].revenue;
    if (declining && last3[2].revenue > 0) {
      const dropPct = Math.round((1 - last3[2].revenue / last3[0].revenue) * 100);
      signals.push({
        id: 'declining_revenue',
        level: dropPct > 30 ? 'critical' : 'warning',
        title: 'Revenue Declining 3 Months',
        message: `Revenue has declined consistently for 3 months (${dropPct}% total drop). Investigate customer acquisition or retention issues.`,
      });
    }
  }

  // High burn rate: current month expenses >1.3× last 3-month avg revenue
  if (rows.length >= 3) {
    const last3Rev  = rows.slice(-3).reduce((s, r) => s + r.revenue, 0) / 3;
    const lastMonth = rows[rows.length - 1];
    if (last3Rev > 0 && lastMonth.expenses > last3Rev * 1.3) {
      signals.push({
        id: 'high_burn_rate',
        level: 'warning',
        title: 'High Expense Burn Rate',
        message: `Last month's expenses (${_fmt(lastMonth.expenses)}) are ${Math.round(lastMonth.expenses / last3Rev * 100)}% of the 3-month average revenue. Review discretionary spending.`,
      });
    }
  }

  return signals;
}

/* ── Compact currency formatter (no external dependency) ── */
function _fmt(val) {
  const n = Math.abs(val || 0);
  if (n >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(val / 1_000).toFixed(1)}K`;
  return Math.round(val || 0).toLocaleString();
}

/* ════════════════════════════════════════════════════════════════════════════
   PUBLIC API
════════════════════════════════════════════════════════════════════════════ */
async function getFinancialInsights(businessId) {
  const [unusualSpending, taxRisk, cashFlowWarnings] = await Promise.allSettled([
    _unusualSpending(businessId),
    _taxRisk(businessId),
    _cashFlowWarnings(businessId),
  ]);

  const extract = result => (result.status === 'fulfilled' ? result.value : []);

  const all = [
    ...extract(unusualSpending),
    ...extract(taxRisk),
    ...extract(cashFlowWarnings),
  ];

  // Sort: critical → warning → info
  const ORDER = { critical: 0, warning: 1, info: 2 };
  all.sort((a, b) => (ORDER[a.level] ?? 3) - (ORDER[b.level] ?? 3));

  return {
    insights: all,
    counts: {
      critical: all.filter(i => i.level === 'critical').length,
      warning:  all.filter(i => i.level === 'warning').length,
      info:     all.filter(i => i.level === 'info').length,
      total:    all.length,
    },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { getFinancialInsights };

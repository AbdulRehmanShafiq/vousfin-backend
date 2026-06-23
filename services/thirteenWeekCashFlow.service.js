// services/thirteenWeekCashFlow.service.js — Phase 8 FR-06.3
//
// 13-Week Rolling Cash Flow Forecast.
//
// Weeks 1-4: committed data (outstanding AR/AP with due dates).
// Weeks 5-13: probabilistic (historical collection/payment rates applied to pipeline).
// Never throws — wraps all sub-queries in try/catch.
'use strict';

const mongoose = require('mongoose');
const logger = require('../config/logger');
const accountRepository = require('../repositories/account.repository');

const WEEKS = 13;

/** Get the ISO week start (Monday) for a date. */
function weekStart(d) {
  const dt = new Date(d);
  const day = dt.getUTCDay(); // 0 = Sunday
  const diff = (day === 0) ? -6 : 1 - day; // adjust to Monday
  dt.setUTCDate(dt.getUTCDate() + diff);
  dt.setUTCHours(0, 0, 0, 0);
  return dt;
}

/** Get the Monday of week N (1-indexed) starting from a given base date. */
function weekStartFor(baseMonday, weekNumber) {
  const d = new Date(baseMonday);
  d.setUTCDate(d.getUTCDate() + (weekNumber - 1) * 7);
  return d;
}

/** Get the Sunday (end) of a week given its Monday. */
function weekEnd(monday) {
  const d = new Date(monday);
  d.setUTCDate(d.getUTCDate() + 6);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

/** Sum amounts from a grouped-by-week result into a map: isoWeekKey → amount. */
function groupByWeekKey(items, dateField = 'dueDate', amtField = 'amount') {
  const map = {};
  for (const item of items) {
    const d = item[dateField] ? new Date(item[dateField]) : null;
    if (!d || isNaN(d)) continue;
    const mon = weekStart(d);
    const key = mon.toISOString().slice(0, 10);
    map[key] = (map[key] || 0) + (Number(item[amtField]) || 0);
  }
  return map;
}

class ThirteenWeekCashFlowService {
  // ── Current cash balance ──────────────────────────────────────────────────
  async _getCashBalance(businessId) {
    try {
      const accounts = await accountRepository.findByBusiness(businessId);
      let total = 0;
      for (const a of accounts) {
        const code = String(a.accountCode || '');
        const subtype = (a.accountSubtype || '').toLowerCase();
        // Bank & Cash accounts (accountSubtype = 'Bank and Cash')
        if (/bank and cash/.test(subtype) || /^1[0-4]/.test(code)) {
          total += Number(a.runningBalance) || 0;
        }
      }
      return total;
    } catch (err) {
      logger.warn('[13wk] _getCashBalance error', { err: err.message });
      return 0;
    }
  }

  // ── Committed AR (outstanding invoices with due dates in next 13 weeks) ──
  async _committedAR(businessId, start, end) {
    try {
      const JournalEntry = require('../models/JournalEntry.model');
      const bizOid = mongoose.Types.ObjectId.isValid(businessId)
        ? new mongoose.Types.ObjectId(businessId)
        : businessId;

      const items = await JournalEntry.aggregate([
        {
          $match: {
            businessId: bizOid,
            transactionType: { $in: ['Credit Sale', 'Accounts Receivable', 'Payment Received'] },
            paymentStatus: { $nin: ['paid', 'fully_paid'] },
            dueDate: { $gte: start, $lte: end },
          },
        },
        {
          $group: {
            _id: '$dueDate',
            amount: { $sum: '$amount' },
          },
        },
        { $project: { _id: 0, dueDate: '$_id', amount: 1 } },
      ]);

      return groupByWeekKey(items, 'dueDate', 'amount');
    } catch (err) {
      logger.warn('[13wk] _committedAR error', { err: err.message });
      return {};
    }
  }

  // ── Committed AP (outstanding bills with due dates in next 13 weeks) ──
  async _committedAP(businessId, start, end) {
    try {
      const JournalEntry = require('../models/JournalEntry.model');
      const bizOid = mongoose.Types.ObjectId.isValid(businessId)
        ? new mongoose.Types.ObjectId(businessId)
        : businessId;

      const items = await JournalEntry.aggregate([
        {
          $match: {
            businessId: bizOid,
            transactionType: { $in: ['Credit Purchase', 'Accounts Payable', 'Payment Made'] },
            paymentStatus: { $nin: ['paid', 'fully_paid'] },
            dueDate: { $gte: start, $lte: end },
          },
        },
        {
          $group: {
            _id: '$dueDate',
            amount: { $sum: '$amount' },
          },
        },
        { $project: { _id: 0, dueDate: '$_id', amount: 1 } },
      ]);

      return groupByWeekKey(items, 'dueDate', 'amount');
    } catch (err) {
      logger.warn('[13wk] _committedAP error', { err: err.message });
      return {};
    }
  }

  // ── Historical collection / payment rates (last 12 weeks) ─────────────
  async _historicalRates(businessId) {
    try {
      const JournalEntry = require('../models/JournalEntry.model');
      const bizOid = mongoose.Types.ObjectId.isValid(businessId)
        ? new mongoose.Types.ObjectId(businessId)
        : businessId;

      const twelveWeeksAgo = new Date();
      twelveWeeksAgo.setDate(twelveWeeksAgo.getDate() - 84); // 12 * 7

      const [arStats, apStats] = await Promise.all([
        JournalEntry.aggregate([
          {
            $match: {
              businessId: bizOid,
              transactionType: { $in: ['Credit Sale', 'Accounts Receivable'] },
              transactionDate: { $gte: twelveWeeksAgo },
            },
          },
          {
            $group: {
              _id: null,
              raised:    { $sum: '$amount' },
              collected: {
                $sum: {
                  $cond: [
                    { $in: ['$paymentStatus', ['paid', 'fully_paid']] },
                    '$amount',
                    0,
                  ],
                },
              },
            },
          },
        ]),
        JournalEntry.aggregate([
          {
            $match: {
              businessId: bizOid,
              transactionType: { $in: ['Credit Purchase', 'Accounts Payable'] },
              transactionDate: { $gte: twelveWeeksAgo },
            },
          },
          {
            $group: {
              _id: null,
              raised: { $sum: '$amount' },
              paid:   {
                $sum: {
                  $cond: [
                    { $in: ['$paymentStatus', ['paid', 'fully_paid']] },
                    '$amount',
                    0,
                  ],
                },
              },
            },
          },
        ]),
      ]);

      const arRaised    = arStats[0]?.raised    || 0;
      const arCollected = arStats[0]?.collected || 0;
      const apRaised    = apStats[0]?.raised    || 0;
      const apPaid      = apStats[0]?.paid      || 0;

      const arRate = arRaised > 0 ? arCollected / arRaised : 0.7; // default 70%
      const apRate = apRaised > 0 ? apPaid / apRaised      : 0.8; // default 80%

      // Average weekly pipeline
      const avgWeeklyAR = arRaised / 12;
      const avgWeeklyAP = apRaised / 12;

      return { arRate, apRate, avgWeeklyAR, avgWeeklyAP };
    } catch (err) {
      logger.warn('[13wk] _historicalRates error', { err: err.message });
      return { arRate: 0.7, apRate: 0.8, avgWeeklyAR: 0, avgWeeklyAP: 0 };
    }
  }

  // ── Main forecast ─────────────────────────────────────────────────────────
  async buildForecast(businessId, { floorAmount = 0 } = {}) {
    const now  = new Date();
    const base = weekStart(now); // Start of the current week (Monday)
    const forecastEnd = weekStartFor(base, WEEKS + 1);

    const [cashBalance, arCommitted, apCommitted, historicalRates] = await Promise.all([
      this._getCashBalance(businessId),
      this._committedAR(businessId, now, forecastEnd),
      this._committedAP(businessId, now, forecastEnd),
      this._historicalRates(businessId),
    ]);

    const { arRate, apRate, avgWeeklyAR, avgWeeklyAP } = historicalRates;
    const COMMITTED_WEEKS = 4; // weeks 1-4 are committed; 5-13 are probabilistic

    const weeks = [];
    let runningBalance = cashBalance;

    for (let w = 1; w <= WEEKS; w++) {
      const monday  = weekStartFor(base, w);
      const sunday  = weekEnd(monday);
      const weekKey = monday.toISOString().slice(0, 10);

      const isCommitted = w <= COMMITTED_WEEKS;
      let inflows  = 0;
      let outflows = 0;

      if (isCommitted) {
        inflows  = arCommitted[weekKey] || 0;
        outflows = apCommitted[weekKey] || 0;
      } else {
        // Probabilistic: apply historical rates to average weekly pipeline
        inflows  = avgWeeklyAR * arRate;
        outflows = avgWeeklyAP * apRate;
      }

      const openingBalance = runningBalance;
      const netCashFlow    = inflows - outflows;
      const closingBalance = openingBalance + netCashFlow;

      weeks.push({
        weekNumber:      w,
        weekStartDate:   monday,
        weekEndDate:     sunday,
        openingBalance,
        inflows:         Math.max(0, inflows),
        outflows:        Math.max(0, outflows),
        netCashFlow,
        closingBalance,
        isAlert:         closingBalance < floorAmount,
        source:          isCommitted ? 'committed' : 'probabilistic',
      });

      runningBalance = closingBalance;
    }

    // Lowest point
    const lowestWeek = weeks.reduce((min, w) =>
      w.closingBalance < min.closingBalance ? w : min, weeks[0]);

    // Weeks until floor
    let weeksUntilFloor = null;
    for (const w of weeks) {
      if (w.isAlert) { weeksUntilFloor = w.weekNumber; break; }
    }

    return {
      currentCashBalance: cashBalance,
      floorAmount,
      weeks,
      lowestPoint: { weekNumber: lowestWeek.weekNumber, balance: lowestWeek.closingBalance },
      weeksUntilFloor,
      generatedAt: new Date(),
    };
  }

  // ── Alerts-only view ──────────────────────────────────────────────────────
  async getLiquidityAlerts(businessId, floorAmount = 0) {
    const forecast = await this.buildForecast(businessId, { floorAmount });
    return forecast.weeks.filter(w => w.isAlert);
  }
}

module.exports = new ThirteenWeekCashFlowService();

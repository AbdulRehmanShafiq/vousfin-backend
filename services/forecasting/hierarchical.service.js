// services/forecasting/hierarchical.service.js
//
// Forecast Platform — Stage B1. Hierarchical (by-stream) forecasting + reconciliation.
//
// Forecasting revenue/expenses by stream (per income/expense account) and
// reconciling so the parts agree with the total is both more accurate (each
// stream has cleaner dynamics) and more useful (you see *which* streams move).
// We forecast every stream + the total directly, then RECONCILE: the reconciled
// total blends the direct and bottom-up views, and the streams are rescaled to
// sum to it exactly.
//
'use strict';
const mongoose = require('mongoose');
const JournalEntry = require('../../models/JournalEntry.model');
const ensembleForecast = require('./ensembleForecast.service');
const { JOURNAL_STATUS } = require('../../config/constants');
const logger = require('../../config/logger');

const oid = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id);
const REVENUE_TYPES = ['Revenue', 'Income'];
const EXPENSE_TYPES = ['Expense', 'Direct Cost', 'Cost'];

/**
 * Pure: reconcile a direct total forecast with per-stream forecasts.
 * @param {number[]} directTotal
 * @param {Array<{name,forecast:number[]}>} streams
 * @param {'proportional'|'bottom_up'} method
 * @returns {{ total, streams, bottomUp, direct, method }}
 */
function reconcile(directTotal, streams, method = 'proportional') {
  const H = directTotal.length;
  const bottomUp = Array.from({ length: H }, (_, h) => streams.reduce((s, st) => s + (st.forecast[h] || 0), 0));
  const total = directTotal.map((d, h) =>
    method === 'bottom_up' ? Math.round(bottomUp[h]) : Math.round((d + bottomUp[h]) / 2));
  // rescale streams so they sum exactly to the reconciled total
  const adjusted = streams.map((st) => ({
    name: st.name,
    forecast: st.forecast.map((v, h) => {
      const f = bottomUp[h] ? total[h] / bottomUp[h] : 1;
      return Math.round((v || 0) * f);
    }),
  }));
  return { total, streams: adjusted, bottomUp: bottomUp.map(Math.round), direct: directTotal.map(Math.round), method };
}

/**
 * Pure: assemble aligned per-account monthly series from grouped rows; keep the
 * top-N streams by total, lump the rest into "Other".
 * @param {Array<{accountName,year,month,amount}>} rows
 * @param {number} topN
 */
function assembleStreams(rows, topN = 5) {
  const months = [...new Set(rows.map((r) => `${r.year}-${String(r.month).padStart(2, '0')}`))].sort();
  const idx = Object.fromEntries(months.map((m, i) => [m, i]));
  const byAccount = {};
  for (const r of rows) {
    const key = `${r.year}-${String(r.month).padStart(2, '0')}`;
    if (!byAccount[r.accountName]) byAccount[r.accountName] = Array(months.length).fill(0);
    byAccount[r.accountName][idx[key]] += r.amount || 0;
  }
  const ranked = Object.entries(byAccount)
    .map(([name, series]) => ({ name, series, total: series.reduce((s, v) => s + v, 0) }))
    .sort((a, b) => b.total - a.total);

  const keep = ranked.slice(0, topN);
  const rest = ranked.slice(topN);
  const streams = keep.map(({ name, series }) => ({ name, series }));
  if (rest.length) {
    const other = Array(months.length).fill(0);
    for (const r of rest) r.series.forEach((v, i) => { other[i] += v; });
    streams.push({ name: 'Other', series: other });
  }
  const total = Array(months.length).fill(0);
  for (const s of streams) s.series.forEach((v, i) => { total[i] += v; });
  return { months, streams, total };
}

class HierarchicalService {
  /** Grouped per-account monthly amounts for a side (revenue/expense). @private */
  async _streamRows(businessId, kind, monthsBack = 24, asOf = new Date()) {
    const accField = kind === 'revenue' ? 'creditAccountId' : 'debitAccountId';
    const types = kind === 'revenue' ? REVENUE_TYPES : EXPENSE_TYPES;
    const start = new Date(asOf); start.setMonth(start.getMonth() - monthsBack); start.setHours(0, 0, 0, 0);
    return JournalEntry.aggregate([
      { $match: {
        businessId: oid(businessId), transactionDate: { $gte: start, $lt: asOf },
        status: { $in: [JOURNAL_STATUS.POSTED, JOURNAL_STATUS.PARTIALLY_SETTLED, JOURNAL_STATUS.SETTLED] },
        isArchived: { $ne: true },
      } },
      { $lookup: { from: 'chartofaccounts', localField: accField, foreignField: '_id', as: 'acc' } },
      { $unwind: { path: '$acc', preserveNullAndEmptyArrays: false } },
      { $match: { 'acc.accountType': { $in: types } } },
      { $group: {
        _id: { name: '$acc.accountName', year: { $year: '$transactionDate' }, month: { $month: '$transactionDate' } },
        amount: { $sum: '$amount' },
      } },
      { $project: { _id: 0, accountName: '$_id.name', year: '$_id.year', month: '$_id.month', amount: 1 } },
      { $sort: { year: 1, month: 1 } },
    ]);
  }

  /** Forecast by stream + reconcile to the total. */
  async forecast(businessId, { target = 'Revenue', horizon = 6 } = {}) {
    const kind = target === 'Expenses' ? 'expense' : 'revenue';
    const rows = await this._streamRows(businessId, kind);
    if (!rows.length) return { target, insufficient: true };

    const { months, streams, total } = assembleStreams(rows, 5);
    if (months.length < 6 || !streams.length) return { target, insufficient: true, months: months.length };

    const period = total.filter((v) => v > 0).length >= 6 ? 3 : 2;
    const streamForecasts = [];
    for (const st of streams) {
      const r = ensembleForecast.computeFromSeries(st.series, { horizon, period });
      streamForecasts.push({ name: st.name, forecast: r ? r.predicted : Array(horizon).fill(Math.round(st.series.at(-1) || 0)) });
    }
    const directRes = ensembleForecast.computeFromSeries(total, { horizon, period });
    const directTotal = directRes ? directRes.predicted : streamForecasts[0].forecast.map((_, h) => streamForecasts.reduce((s, st) => s + st.forecast[h], 0));

    const reconciled = reconcile(directTotal, streamForecasts, 'proportional');
    logger.info(`[hierarchical] ${target}: ${streams.length} streams reconciled over ${horizon}m`);
    return {
      target, horizon, method: reconciled.method,
      total: reconciled.total, streams: reconciled.streams,
      directTotal: reconciled.direct, bottomUpTotal: reconciled.bottomUp,
      streamCount: streams.length,
    };
  }
}

module.exports = new HierarchicalService();
module.exports.reconcile = reconcile;
module.exports.assembleStreams = assembleStreams;

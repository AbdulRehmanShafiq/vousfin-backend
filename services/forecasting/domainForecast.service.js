// services/forecasting/domainForecast.service.js
//
// Forecast Platform — F6. Domain forecast adapters on the shared ensemble +
// feature spine. Each domain fetches the series/state it needs (tenant-scoped),
// runs the right model (ensemble, Monte-Carlo, survival, Croston, OLS), and
// returns a domain-shaped result. Standard time-series domains (profitability,
// debt) flow through the F3 gate; specialist domains return their native output.
//
'use strict';
const mongoose = require('mongoose');
const ChartOfAccount = require('../../models/ChartOfAccount.model');
const Invoice = require('../../models/Invoice.model');
const InventoryItem = require('../../models/InventoryItem.model');
const CurrencyRate = require('../../models/CurrencyRate.model');
const ensembleForecast = require('./ensembleForecast.service');
const forecastStore = require('./forecastStore.service');
const liquidity = require('./domains/liquidityStress');
const survival = require('./domains/survival');
const { croston } = require('./domains/croston');
const sensitivity = require('./domains/sensitivity');
const { cache } = require('./infra/cache');           // F8 — tenant-namespaced cache
const logger = require('../../config/logger');

const MS_DAY = 86400000;
const oid = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id);
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

async function _monthly(businessId) {
  const lstm = require('./lstmForecastService');
  return lstm.fetchMonthlyData(businessId, 24);
}

async function _accountTotals(businessId) {
  const rows = await ChartOfAccount.aggregate([
    { $match: { businessId: oid(businessId) } },
    { $group: { _id: '$accountType', total: { $sum: '$runningBalance' } } },
  ]);
  const t = {}; for (const r of rows) t[r._id] = r.total;
  return t;
}

async function _currentCash(businessId) {
  const rows = await ChartOfAccount.aggregate([
    { $match: { businessId: oid(businessId), accountCode: { $in: ['1010', '1020', '1030', '1040'] } } },
    { $group: { _id: null, cash: { $sum: '$runningBalance' } } },
  ]);
  return rows[0]?.cash || 0;
}

class DomainForecastService {
  /** Profitability — ensemble forecast of net profit. */
  async profitability(businessId, horizon = 6) {
    const monthly = await _monthly(businessId);
    const series = monthly.map((m) => m.profit);
    const res = ensembleForecast.computeFromSeries(series, { horizon, period: series.filter((v) => v > 0).length >= 6 ? 3 : 2 });
    if (!res) return { domain: 'profitability', insufficient: true };
    forecastStore.recordForecast(businessId, {
      target: 'Profitability', granularity: 'monthly', horizon, series, period: res.period,
      forecastFn: res.forecastFn, modelType: res.modelType, predicted: res.predicted, lower: res.lower, upper: res.upper, dataSource: 'live',
    }).catch(() => {});
    return { domain: 'profitability', modelType: res.modelType, predicted: res.predicted, lower: res.lower, upper: res.upper, weights: res.weights, coverageTarget: res.coverageTarget };
  }

  /** Liquidity stress — Monte-Carlo VaR on net cash flow from the current cash position. */
  async liquidityStress(businessId, horizon = 6) {
    const [monthly, currentCash] = await Promise.all([_monthly(businessId), _currentCash(businessId)]);
    const netChanges = monthly.map((m) => m.cashFlow);
    if (netChanges.filter((v) => v !== 0).length < 2) return { domain: 'liquidity_stress', insufficient: true, currentCash: r2(currentCash) };
    const stress = liquidity.monteCarloVaR(currentCash, netChanges, { horizon, sims: 2000, alpha: 0.05 });
    // expected cash trajectory via the ensemble on net cash flow
    const ef = ensembleForecast.computeFromSeries(netChanges, { horizon, period: 3 });
    let trajectory = [];
    if (ef) { let c = currentCash; trajectory = ef.predicted.map((d) => { c = r2(c + d); return c; }); }
    return { domain: 'liquidity_stress', ...stress, expectedCashTrajectory: trajectory };
  }

  /** Debt exposure — current liabilities + projected new debt + coverage ratios. */
  async debtExposure(businessId, horizon = 6) {
    const [monthly, totals] = await Promise.all([_monthly(businessId), _accountTotals(businessId)]);
    const liabilities = r2(totals.Liability || 0);
    const assets = r2(totals.Asset || 0);
    // proxy net-new-debt signal: monthly expenses growth feeds projected liabilities
    const series = monthly.map((m) => m.expenses);
    const ef = ensembleForecast.computeFromSeries(series, { horizon, period: 3 });
    const projectedNewDebt = ef ? r2(ef.predicted.reduce((s, v) => s + v, 0) * 0.1) : 0; // ~10% of spend financed
    return {
      domain: 'debt_exposure',
      currentLiabilities: liabilities, currentAssets: assets,
      debtToAssetRatio: assets > 0 ? Math.round((liabilities / assets) * 10000) / 10000 : null,
      projectedLiabilities: r2(liabilities + projectedNewDebt),
      coverageRatio: liabilities > 0 ? Math.round((assets / liabilities) * 10000) / 10000 : null,
      horizon,
    };
  }

  /** AR payment behavior — Kaplan-Meier time-to-payment + collection schedule. */
  async arPaymentBehavior(businessId) {
    const invoices = await Invoice.find({
      businessId: oid(businessId), isArchived: { $ne: true },
      state: { $in: ['paid', 'partially_paid', 'approved', 'sent', 'overdue'] },
    }).select('issueDate updatedAt state remainingBalance totalAmount').lean();
    if (invoices.length < 4) return { domain: 'ar_payment_behavior', insufficient: true };

    const now = Date.now();
    const durations = []; const events = [];
    let openAR = 0;
    for (const inv of invoices) {
      const issue = new Date(inv.issueDate).getTime();
      const paid = inv.state === 'paid';
      const end = paid ? new Date(inv.updatedAt).getTime() : now;
      const days = Math.max(1, Math.round((end - issue) / MS_DAY));
      durations.push(days);
      events.push(paid ? 1 : 0);
      if (!paid) openAR += inv.remainingBalance || 0;
    }
    const curve = survival.kaplanMeier(durations, events);
    return {
      domain: 'ar_payment_behavior',
      medianDaysToPay: survival.medianDaysToPay(curve),
      meanDaysToPay: survival.meanDaysToPay(curve),
      openReceivables: r2(openAR),
      collectionSchedule: survival.collectionSchedule(curve, openAR, { buckets: 3, bucketDays: 30 }),
      survivalCurve: curve.slice(0, 24),
    };
  }

  /** Inventory demand — Croston (intermittent) + ensemble on a demand proxy + current stock state. */
  async inventoryDemand(businessId, horizon = 6) {
    const monthly = await _monthly(businessId);
    const demand = monthly.map((m) => m.revenue);   // sales-value proxy for aggregate demand
    const cr = croston(demand, { alpha: 0.2, horizon });
    const ef = ensembleForecast.computeFromSeries(demand, { horizon, period: 3 });
    const snap = await InventoryItem.aggregate([
      { $match: { businessId: oid(businessId) } },
      { $group: { _id: null, stockValue: { $sum: { $multiply: ['$currentStock', '$unitCostPrice'] } }, items: { $sum: 1 }, lowStock: { $sum: { $cond: [{ $lte: ['$currentStock', '$reorderLevel'] }, 1, 0] } } } },
    ]);
    const s = snap[0] || { stockValue: 0, items: 0, lowStock: 0 };
    return {
      domain: 'inventory_demand',
      method: cr.intermittent ? 'Croston (intermittent)' : 'Ensemble',
      demandForecast: cr.intermittent ? cr.forecast : (ef ? ef.predicted : cr.forecast),
      crostonRate: cr.rate, intermittent: cr.intermittent,
      currentStockValue: r2(s.stockValue), itemCount: s.items, lowStockItems: s.lowStock,
      note: 'Aggregate demand-value proxy (revenue); per-SKU demand in a later pass.',
    };
  }

  /** Macro sensitivity — OLS of revenue on the base→USD FX rate. */
  async macroSensitivity(businessId) {
    const monthly = await _monthly(businessId);
    // monthly base→USD FX from CurrencyRate (averaged per month)
    let fxRows = [];
    try {
      fxRows = await CurrencyRate.aggregate([
        { $match: { businessId: oid(businessId), toCurrency: 'USD' } },
        { $group: { _id: { y: { $year: '$rateDate' }, m: { $month: '$rateDate' } }, rate: { $avg: '$rate' } } },
      ]);
    } catch (e) { logger.warn(`[domainForecast] FX read failed: ${e.message}`); }
    const fxByMonth = {}; for (const r of fxRows) fxByMonth[`${r._id.y}-${r._id.m}`] = r.rate;

    const pairs = monthly
      .map((m) => ({ rev: m.revenue, fx: fxByMonth[`${m.year}-${m.month}`] }))
      .filter((p) => p.fx != null && p.rev != null);
    if (pairs.length < 3) {
      return { domain: 'macro_sensitivity', available: false, note: 'Insufficient aligned FX history — add FX rates or wait for more data.' };
    }
    const model = sensitivity.regress(pairs.map((p) => p.fx), pairs.map((p) => p.rev));
    return {
      domain: 'macro_sensitivity', available: true, factor: 'FX (base→USD)',
      beta: model.beta, rSquared: model.r2, elasticity: model.elasticity, correlation: model.correlation, points: model.n,
      scenarios: {
        fx_minus_10pct: sensitivity.project(model, mean(pairs.map((p) => p.fx)) * 0.9),
        fx_plus_10pct: sensitivity.project(model, mean(pairs.map((p) => p.fx)) * 1.1),
      },
    };
  }

  async forecast(businessId, domain, horizon = 6) {
    // F8 — cache-aside (tenant-namespaced, 5-min TTL) to absorb repeated reads.
    return cache.wrap(cache.key(businessId, 'domain', domain, horizon), 5 * 60 * 1000,
      () => this._forecast(businessId, domain, horizon));
  }

  async _forecast(businessId, domain, horizon = 6) {
    switch (domain) {
      case 'profitability':       return this.profitability(businessId, horizon);
      case 'liquidity-stress':    return this.liquidityStress(businessId, horizon);
      case 'debt-exposure':       return this.debtExposure(businessId, horizon);
      case 'ar-payment-behavior': return this.arPaymentBehavior(businessId);
      case 'inventory-demand':    return this.inventoryDemand(businessId, horizon);
      case 'macro-sensitivity':   return this.macroSensitivity(businessId);
      default: { const e = new Error(`Unknown domain: ${domain}`); e.statusCode = 400; throw e; }
    }
  }
}

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }

module.exports = new DomainForecastService();

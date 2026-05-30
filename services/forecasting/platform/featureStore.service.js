// services/forecasting/platform/featureStore.service.js
//
// Forecast Platform — Foundation (F1). FEATURE STORE + FEATURE-ENGINEERING PIPELINE.
//
// Turns a built dataset into leakage-safe, point-in-time feature vectors and
// persists them as ForecastFeatureSnapshot rows (idempotent upsert) — which also
// serves as the HISTORICAL SNAPSHOT system (each row carries `knowledgeDate`,
// the cutoff after which no data informed it). Registers lineage in
// ForecastDatasetRegistry.
//
// LEAKAGE GUARANTEE: features for period t are computed strictly from periods
// ≤ t. `computeFeatures()` is pure and unit-tested to never read row[t+k].
//
'use strict';
const mongoose = require('mongoose');
const ForecastFeatureSnapshot = require('../../../models/ForecastFeatureSnapshot.model');
const ForecastDatasetRegistry = require('../../../models/ForecastDatasetRegistry.model');
const datasetBuilder = require('./datasetBuilder.service');
const { assertTenant } = require('./tenantScope');
const logger = require('../../../config/logger');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const std  = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };

function quarterOf(periodStart) { return Math.floor(new Date(periodStart).getUTCMonth() / 3) + 1; }

/**
 * Pure, leakage-safe feature engineering.
 * For each row t, uses ONLY rows[0..t]. Returns [{ ...row, features, target, knowledgeDate }].
 */
function computeFeatures(rows) {
  return rows.map((row, t) => {
    const past = rows.slice(0, t + 1);              // inclusive of t (period close is "known")
    const rev = past.map((r) => r.revenue);
    const exp = past.map((r) => r.expenses);
    const ncf = past.map((r) => r.netCashFlow);

    const lag = (arr, k) => (t - k >= 0 ? arr[t - k] : null);
    const last3Rev = rev.slice(-3);
    const momGrowth = (t >= 1 && rev[t - 1])
      ? r2(((rev[t] - rev[t - 1]) / rev[t - 1]) * 100) : 0;

    const features = {
      // lags
      revenue_lag1: lag(rev, 1), revenue_lag3: lag(rev, 3),
      expenses_lag1: lag(exp, 1), netCashFlow_lag1: lag(ncf, 1),
      // rolling stats (trailing, inclusive of t)
      revenue_roll3_mean: r2(mean(last3Rev)),
      revenue_roll3_std:  r2(std(last3Rev)),
      // momentum
      revenue_mom_pct: momGrowth,
      // AR/AP exposure
      ar_new: row.arNew || 0, ap_new: row.apNew || 0,
      ar_minus_ap: r2((row.arNew || 0) - (row.apNew || 0)),
      // F2 — multi-source period features (cash, payroll, party activity)
      cash_inflow: row.cashInflow || 0, cash_outflow: row.cashOutflow || 0,
      net_cash_movement: r2((row.cashInflow || 0) - (row.cashOutflow || 0)),
      payroll_expense: row.payrollExpense || 0,
      active_customers: row.activeCustomers || 0, active_vendors: row.activeVendors || 0,
      new_invoices: row.newInvoices || 0, new_bills: row.newBills || 0,
      // activity
      entries: row.entries || 0,
      // calendar
      period_index: t,
      month: new Date(row.periodStart).getUTCMonth() + 1,
      quarter: quarterOf(row.periodStart),
    };

    const target = {
      revenue: row.revenue, expenses: row.expenses, netCashFlow: row.netCashFlow,
    };

    return {
      periodKey: row.periodKey, periodStart: row.periodStart, periodEnd: row.periodEnd,
      knowledgeDate: row.periodEnd,           // data only known at period close
      baseCurrency: row.baseCurrency,
      features, target,
    };
  });
}

class FeatureStoreService {
  /**
   * Build → engineer → persist → register, end to end.
   * @returns {Promise<{ datasetKey, granularity, rowCount, validation, registryId, contentHash }>}
   */
  async materialize(businessId, opts = {}, actor = null) {
    assertTenant(businessId);
    const { meta, rows, validation, contentHash } = await datasetBuilder.buildDataset(businessId, opts);
    const engineered = computeFeatures(rows);

    // ── Persist snapshots (idempotent upsert per period) ─────────────────────
    const dbReady = mongoose.connection && mongoose.connection.readyState === 1;
    if (dbReady && engineered.length) {
      const ops = engineered.map((e) => ({
        updateOne: {
          filter: { businessId, datasetKey: meta.datasetKey, granularity: meta.granularity, periodKey: e.periodKey },
          update: { $set: {
            businessId, datasetKey: meta.datasetKey, granularity: meta.granularity,
            periodKey: e.periodKey, periodStart: e.periodStart, periodEnd: e.periodEnd,
            knowledgeDate: e.knowledgeDate, baseCurrency: e.baseCurrency,
            sourceVersion: contentHash, features: e.features, target: e.target,
          } },
          upsert: true,
        },
      }));
      try { await ForecastFeatureSnapshot.bulkWrite(ops, { ordered: false }); }
      catch (e) { logger.warn(`[featureStore] snapshot bulkWrite failed: ${e.message}`); }
    }

    // ── Register lineage (version bump per rebuild) ──────────────────────────
    let registryId = null;
    if (dbReady) {
      try {
        const prior = await ForecastDatasetRegistry.findOne({
          businessId, datasetKey: meta.datasetKey, granularity: meta.granularity,
        }).sort({ version: -1 }).select('version').lean();
        const reg = await ForecastDatasetRegistry.create({
          businessId, datasetKey: meta.datasetKey, granularity: meta.granularity,
          version: (prior?.version || 0) + 1,
          sources: meta.sources, rangeStart: meta.rangeStart, rangeEnd: meta.rangeEnd,
          rowCount: meta.rowCount, baseCurrency: meta.baseCurrency, tzOffsetMinutes: meta.tzOffsetMinutes,
          contentHash, validation, status: validation.passed ? 'materialized' : 'failed',
          builtBy: actor?._id || null,
        });
        registryId = reg._id;
      } catch (e) { logger.warn(`[featureStore] registry write failed: ${e.message}`); }
    }

    logger.info(`[featureStore] materialized ${engineered.length} ${meta.granularity} periods for business=${businessId} (${meta.datasetKey})`);
    return {
      datasetKey: meta.datasetKey, granularity: meta.granularity,
      rowCount: meta.rowCount, validation, registryId, contentHash,
      meta, sample: engineered.slice(-3),
    };
  }

  /** Read persisted features "as known on" a date (powers reproducible backtests). */
  async getSnapshots(businessId, { datasetKey = 'core-financials', granularity = 'monthly', asOf } = {}) {
    assertTenant(businessId);
    const q = { businessId, datasetKey, granularity };
    if (asOf) q.knowledgeDate = { $lte: new Date(asOf) };
    return ForecastFeatureSnapshot.find(q).sort({ periodStart: 1 }).lean();
  }
}

module.exports = new FeatureStoreService();
module.exports.computeFeatures = computeFeatures;

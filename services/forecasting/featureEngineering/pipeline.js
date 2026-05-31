// services/forecasting/featureEngineering/pipeline.js
//
// Forecast Platform — Feature Engineering Framework. The engineering pipeline.
//
// Turns F1/F2 dataset rows into the full leakage-safe engineered feature matrix
// across the five families (financial_health · behavioral · seasonality · risk).
// Every column is built with the causal transforms in transforms.js, so the
// matrix is leakage-free by construction. Stock (snapshot) features are attached
// only where actually known — never back-filled into the past.
//
'use strict';
const t = require('./transforms');
const calendar = require('./calendar');

const r4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);
const safeDiv = (a, b) => (b ? a / b : null);

/** Causal regime-shift score: |mean(recent w) − mean(prior w)| / σ (trailing). */
function regimeShift(series, w = 3) {
  return series.map((_, i) => {
    if (i < 2 * w - 1) return null;
    const recent = series.slice(i - w + 1, i + 1);
    const prior = series.slice(i - 2 * w + 1, i - w + 1);
    const mr = t._mean(recent); const mp = t._mean(prior);
    const sd = t._std(series.slice(0, i + 1)) || 1;
    return r4(Math.abs(mr - mp) / sd);
  });
}

/**
 * @param {Array} rows  dataset-builder rows (periodKey, revenue, expenses, …)
 * @param {Object} opts { anomalyRisk:{riskScore}, periods:[12,4] }
 * @returns {{ features:Array<Object>, columns:Object<string,Array>, leakageSafe:true }}
 */
function engineer(rows, opts = {}) {
  const periods = opts.periods || [12, 4];
  const anomalyScore = opts.anomalyRisk?.riskScore || 0;
  const n = rows.length;

  const revenue = rows.map((r) => r.revenue || 0);
  const expenses = rows.map((r) => r.expenses || 0);
  const profit = rows.map((r) => (r.profit != null ? r.profit : (r.revenue || 0) - (r.expenses || 0)));
  const netCF = rows.map((r) => (r.netCashFlow != null ? r.netCashFlow : (r.revenue || 0) - (r.expenses || 0)));
  const activeCustomers = rows.map((r) => r.activeCustomers || 0);

  // ── precompute causal transform columns ──────────────────────────────────
  const cols = {
    // financial_health (flow)
    revenue_growth: t.pctChange(revenue, 1),
    expense_growth: t.pctChange(expenses, 1),
    profit_margin: revenue.map((rev, i) => (rev ? r4(profit[i] / rev) : null)),
    cash_burn_rate: netCF.map((v) => r4(Math.max(0, -v))),
    operating_leverage: (() => {
      const dp = t.pctChange(profit, 1); const dr = t.pctChange(revenue, 1);
      return dp.map((v, i) => (v == null || !dr[i] ? null : r4(v / dr[i])));
    })(),
    // transforms
    revenue_lag1: t.lag(revenue, 1), revenue_lag3: t.lag(revenue, 3),
    revenue_roll3_mean: t.rollingMean(revenue, 3), revenue_roll3_std: t.rollingStd(revenue, 3),
    revenue_ewma: t.ewma(revenue, { span: 3 }),
    revenue_zscore6: t.rollingZScore(revenue, 6),
    expenses_lag1: t.lag(expenses, 1),
    // risk
    volatility: (() => { const m = t.rollingMean(revenue, 6); const s = t.rollingStd(revenue, 6); return m.map((mu, i) => (mu && s[i] != null ? r4(s[i] / mu) : null)); })(),
    spending_spike: t.rollingZScore(expenses, 6),
    regime_shift: regimeShift(revenue, 3),
    fraud_influence: revenue.map(() => r4(anomalyScore)),
    anomaly_adjusted_trend: revenue.map((v) => r4(v * (1 - anomalyScore))),
    // behavioral
    collection_velocity: rows.map((r) => safeDiv(r.cashInflow || 0, r.arNew || 0)),
    vendor_payment_cycle: rows.map((r) => safeDiv(r.cashOutflow || 0, r.apNew || 0)),
    churn_signal: t.diff(activeCustomers, 1).map((v) => (v == null ? null : r4(Math.min(0, v)))),
    recurring_revenue_stability: (() => { const m = t.rollingMean(revenue, 6); const s = t.rollingStd(revenue, 6); return m.map((mu, i) => (s[i] ? r4(mu / s[i]) : null)); })(),
  };

  // ── seasonality (Fourier) ────────────────────────────────────────────────
  const fourier = t.fourierFeatures(n, periods, 2);

  // ── assemble per-period feature objects ──────────────────────────────────
  const features = rows.map((row, i) => {
    const f = { periodKey: row.periodKey, knowledgeDate: row.periodEnd };
    for (const [name, arr] of Object.entries(cols)) f[name] = arr[i];
    Object.assign(f, fourier[i]);
    // B2 — calendar/seasonality regressors (causal: derived only from the date)
    const ps = new Date(row.periodStart);
    const mm = ps.getUTCMonth() + 1;
    f.is_quarter_end_month = mm % 3 === 0 ? 1 : 0;
    f.is_year_end_month = mm === 12 ? 1 : 0;
    f.holiday_count = calendar.holidaysInMonth(ps.getUTCFullYear(), mm).length;
    // snapshot (stock) features only where genuinely known (no back-fill → no leakage)
    if (row.totalAssets != null) f.debt_ratio = safeDiv(row.totalLiabilities || 0, row.totalAssets) != null ? r4((row.totalLiabilities || 0) / row.totalAssets) : null;
    if (row.totalAssets != null && row.totalLiabilities != null) {
      f.liquidity_ratio = row.totalLiabilities ? r4(row.totalAssets / row.totalLiabilities) : null;
      f.working_capital = r4((row.totalAssets || 0) - (row.totalLiabilities || 0));
    }
    return f;
  });

  // expose Fourier names in the columns map too
  for (const k of Object.keys(fourier[0] || {})) cols[k] = fourier.map((f) => f[k]);

  return { features, columns: cols, leakageSafe: true, families: require('./catalog').listFamilies() };
}

module.exports = { engineer, regimeShift };

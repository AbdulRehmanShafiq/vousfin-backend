// services/forecasting/ensembleForecast.service.js
//
// Forecast Platform — F4. Orchestrates the multi-model ensemble end to end:
//   members → backtest-weighted combination → point forecast
//           → split-conformal calibrated intervals
//           → F3 baseline gate + registry persistence.
//
// `computeFromSeries` is pure (no I/O) so it is unit-tested and reused by the
// lstm fallback to replace the single-model path. `forecast` adds the DB-backed
// gate/persistence for the standalone API.
//
'use strict';
const ensemble = require('./ensemble');
const conformal = require('./conformal');
const forecastStore = require('./forecastStore.service');

const METRIC_KEY = { Revenue: 'revenue', Expenses: 'expenses', 'Net Cash Flow': 'profit' };

/**
 * Pure: build the ensemble on a numeric series, produce the point forecast and
 * conformal-calibrated intervals. Returns null when history is too short.
 */
function computeFromSeries(series, { horizon = 6, period = 3, alpha = 0.1 } = {}) {
  const raw = (series || []).filter((v) => v != null && v >= 0);
  if (raw.length < 4) return null;

  const { forecastFn, weights, memberEvals } = ensemble.buildEnsemble(raw, { horizon, period });
  const point = forecastFn(raw, horizon).map((v) => Math.round(v));
  const ci = conformal.conformalIntervals(raw, forecastFn, point, { alpha, period, horizon });
  const activeMembers = Object.keys(weights).filter((n) => weights[n] > 0).length || Object.keys(memberEvals).length;

  return {
    predicted: point, lower: ci.lower, upper: ci.upper,
    widths: ci.widths, coverageTarget: ci.coverageTarget,
    weights, memberEvals, period, forecastFn,
    modelType: `Ensemble (${activeMembers}-model, conformal ${ci.coverageTarget}%)`,
  };
}

/**
 * DB-backed: fetch the tenant's monthly series, build the ensemble, then run it
 * through the F3 gate + persist the run. Used by the standalone /ensemble API.
 */
async function forecast(businessId, target = 'Revenue', granularity = 'monthly', horizon = 6) {
  const lstm = require('./lstmForecastService'); // lazy — avoids a require cycle
  const metric = METRIC_KEY[target] || 'revenue';
  const monthly = await lstm.fetchMonthlyData(businessId, 24);
  const series = monthly.map((m) => m[metric]);
  const period = series.filter((v) => v > 0).length >= 6 ? 3 : 2;

  const res = computeFromSeries(series, { horizon, period, alpha: 0.1 });
  if (!res) return { insufficient: true, target, horizon, generatedAt: new Date().toISOString() };

  const verdict = await forecastStore.recordForecast(businessId, {
    target, granularity, horizon, series: series.filter((v) => v >= 0), period,
    forecastFn: res.forecastFn, modelType: res.modelType,
    predicted: res.predicted, lower: res.lower, upper: res.upper, dataSource: 'live',
  });

  return {
    target, horizon, modelType: res.modelType,
    predicted: res.predicted, lower: res.lower, upper: res.upper,
    weights: res.weights, coverageTarget: res.coverageTarget,
    baselineGate: verdict, generatedAt: new Date().toISOString(),
  };
}

module.exports = { computeFromSeries, forecast };

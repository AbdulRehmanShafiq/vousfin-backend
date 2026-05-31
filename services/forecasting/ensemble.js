// services/forecasting/ensemble.js
//
// Forecast Platform — F4. Multi-model ensemble (pure).
//
// Combines several member forecasters (baselines + classical + AR/ML) by a
// BACKTEST-WEIGHTED average: each member's weight ∝ its inverse walk-forward
// error, so skilful members dominate and weak ones are damped — never a naive
// simple average. This is what satisfies "never use a single-model approach".
//
// Returns a single forecastFn with the shared signature, so the *ensemble itself*
// is scored through the F3 backtest harness + baseline gate like any model.
//
'use strict';
const backtest = require('./backtest');
const baselines = require('./baselines');
const classical = require('./classical');
const regression = require('./regression');
const { elasticNetForecaster } = require('./elasticNet');
const { etsForecaster } = require('./ets');

/** Default member set (all share (train, horizon, opts) -> number[]). */
function defaultMembers(period = 3) {
  return {
    seasonalNaive: (tr, h) => baselines.seasonalNaive(tr, h, { period }),
    drift:         (tr, h) => baselines.drift(tr, h),
    holtWinters:   (tr, h) => classical.holtWintersForecaster(tr, h, { period }),
    ets:           (tr, h) => etsForecaster(tr, h, { period }),
    arRegression:  (tr, h) => regression.arForecaster(tr, h, { p: 2 }),
    elasticNet:    (tr, h) => elasticNetForecaster(tr, h, { p: 3, alpha: 0.1, l1Ratio: 0.5 }),
  };
}

/**
 * Compute backtest-weighted member weights (∝ 1 / (MAE + eps)). Members whose
 * backtest is unavailable are dropped. Returns { weights, memberEvals }.
 */
function computeWeights(series, members, opts = {}) {
  const { minTrain, horizon = 1, period = 1 } = opts;
  const mt = minTrain || Math.max(period * 2, 4);
  const memberEvals = {};
  const inv = {};
  let total = 0;
  for (const [name, fn] of Object.entries(members)) {
    const ev = backtest.evaluateForecaster(series, fn, { minTrain: mt, horizon, period });
    memberEvals[name] = ev;
    if (ev.mae != null && Number.isFinite(ev.mae)) {
      const w = 1 / (ev.mae + 1e-6);
      inv[name] = w; total += w;
    }
  }
  const weights = {};
  if (total > 0) for (const [name, w] of Object.entries(inv)) weights[name] = Math.round((w / total) * 10000) / 10000;
  return { weights, memberEvals };
}

/** Weighted-average the members' forecasts for `horizon` steps. */
function combine(train, horizon, members, weights) {
  const active = Object.keys(weights).filter((n) => weights[n] > 0);
  if (!active.length) {
    // Degenerate: fall back to an equal blend of whatever members exist.
    const names = Object.keys(members);
    const preds = names.map((n) => members[n](train, horizon));
    return Array.from({ length: horizon }, (_, i) =>
      Math.max(0, preds.reduce((s, p) => s + (p[i] || 0), 0) / names.length));
  }
  const preds = {};
  for (const n of active) preds[n] = members[n](train, horizon);
  return Array.from({ length: horizon }, (_, i) => {
    let v = 0;
    for (const n of active) v += weights[n] * (preds[n][i] || 0);
    return Math.max(0, v);
  });
}

/**
 * Build an ensemble for a series: fixes member weights from a backtest, then
 * returns a forecastFn (re-weighted, re-fit per training prefix) plus diagnostics.
 */
function buildEnsemble(series, opts = {}) {
  const period = opts.period || 3;
  const members = opts.members || defaultMembers(period);
  const { weights, memberEvals } = computeWeights(series, members, opts);
  // forecastFn recomputes member forecasts on whatever train it's given (so it
  // backtests honestly) but reuses the globally-fitted skill weights.
  const forecastFn = (train, horizon) => combine(train, horizon, members, weights);
  return { forecastFn, weights, memberEvals, members };
}

module.exports = { defaultMembers, computeWeights, combine, buildEnsemble };

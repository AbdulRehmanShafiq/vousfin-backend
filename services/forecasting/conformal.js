// services/forecasting/conformal.js
//
// Forecast Platform — F4 down-payment. SPLIT CONFORMAL PREDICTION (pure).
//
// Distribution-free, model-agnostic prediction intervals with (approximately)
// guaranteed coverage — replaces heuristic ±% bands. Method: run the model
// walk-forward, collect absolute residuals per horizon step, take the (1−alpha)
// empirical quantile of those residuals as the half-width for that step, and
// widen the bands with the horizon as uncertainty compounds.
//
// Pure functions, no I/O — reuses the leakage-safe backtest harness.
//
'use strict';
const backtest = require('./backtest');

/** Empirical (1−alpha) quantile of a sample (linear interpolation, clamped). */
function quantile(values, q) {
  const a = values.filter((v) => Number.isFinite(v)).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const pos = Math.min(a.length - 1, Math.max(0, q * (a.length - 1)));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

/**
 * Per-step conformal half-widths from walk-forward residuals.
 * @param {number[]} series
 * @param {(train,horizon,opts)=>number[]} forecastFn
 * @param {Object} opts { horizon, minTrain, period, alpha }
 * @returns {{ widths:number[], alpha:number, samples:number }}
 */
function calibrate(series, forecastFn, opts = {}) {
  const { horizon = 6, minTrain, period = 1, alpha = 0.1 } = opts;
  const mt = minTrain || Math.max(period * 2, 4);
  const folds = backtest.rollingOriginSplits(series, { minTrain: mt, horizon, step: 1 });

  // residualsByStep[k] = |actual − pred| observed at horizon step k+1 across folds
  const residualsByStep = Array.from({ length: horizon }, () => []);
  for (const f of folds) {
    const preds = forecastFn(f.train, f.test.length, { period }) || [];
    for (let i = 0; i < f.test.length; i++) {
      if (preds[i] != null) residualsByStep[i].push(Math.abs(f.test[i] - preds[i]));
    }
  }

  // Fallback when a step never appeared in a fold: reuse the last known width.
  let lastWidth = 0;
  const widths = residualsByStep.map((res) => {
    if (res.length) { lastWidth = quantile(res, 1 - alpha); return lastWidth; }
    return lastWidth; // compounding fallback for far horizons
  });
  const samples = residualsByStep.reduce((s, r) => s + r.length, 0);
  return { widths: widths.map((w) => Math.round(w * 100) / 100), alpha, samples };
}

/** Apply per-step half-widths to a point forecast → calibrated lower/upper. */
function applyIntervals(predicted, widths) {
  const lower = predicted.map((v, i) => Math.round(Math.max(0, v - (widths[i] != null ? widths[i] : widths[widths.length - 1] || 0))));
  const upper = predicted.map((v, i) => Math.round(v + (widths[i] != null ? widths[i] : widths[widths.length - 1] || 0)));
  return { lower, upper };
}

/**
 * One-shot: calibrate on history, then band a point forecast.
 * @returns {{ lower, upper, widths, alpha, coverageTarget, samples }}
 */
function conformalIntervals(series, forecastFn, predicted, opts = {}) {
  const { alpha = 0.1 } = opts;
  const { widths, samples } = calibrate(series, forecastFn, { ...opts, horizon: predicted.length });
  const { lower, upper } = applyIntervals(predicted, widths);
  return { lower, upper, widths, alpha, coverageTarget: Math.round((1 - alpha) * 100), samples };
}

module.exports = { quantile, calibrate, applyIntervals, conformalIntervals };

// services/forecasting/featureEngineering/transforms.js
//
// Forecast Platform — Feature Engineering Framework. Causal time-series
// transforms (pure, leakage-safe).
//
// EVERY transform here is CAUSAL: the value at position t depends only on
// observations at indices ≤ t. Positions with insufficient history return null
// (never forward-filled, never look-ahead), so any feature matrix built from
// these is leakage-free by construction.
//
'use strict';

const r4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const std = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };

/** Lag by k: out[t] = series[t-k] (null for t<k). */
function lag(series, k = 1) {
  return series.map((_, t) => (t - k >= 0 ? series[t - k] : null));
}

/** Trailing rolling reducer over a window ending at t (inclusive). */
function _rolling(series, window, reducer, minPeriods = 1) {
  return series.map((_, t) => {
    const slice = series.slice(Math.max(0, t - window + 1), t + 1);
    return slice.length >= minPeriods ? r4(reducer(slice)) : null;
  });
}

const rollingMean = (s, w = 3) => _rolling(s, w, mean);
const rollingStd  = (s, w = 3) => _rolling(s, w, std, 2);
const rollingMin  = (s, w = 3) => _rolling(s, w, (a) => Math.min(...a));
const rollingMax  = (s, w = 3) => _rolling(s, w, (a) => Math.max(...a));
const rollingSum  = (s, w = 3) => _rolling(s, w, (a) => a.reduce((x, y) => x + y, 0));

/** Trailing rolling z-score: (x_t − μ_w) / σ_w. */
function rollingZScore(series, window = 6) {
  const mu = rollingMean(series, window);
  const sd = rollingStd(series, window);
  return series.map((x, t) => (mu[t] == null || !sd[t] ? null : r4((x - mu[t]) / sd[t])));
}

/** Exponentially-weighted moving average (causal). span → alpha = 2/(span+1). */
function ewma(series, { alpha, span } = {}) {
  const a = alpha != null ? alpha : (span != null ? 2 / (span + 1) : 0.3);
  let prev = null;
  return series.map((x) => {
    if (x == null) return prev;
    prev = prev == null ? x : a * x + (1 - a) * prev;
    return r4(prev);
  });
}

/** k-step difference: out[t] = series[t] − series[t-k]. */
function diff(series, k = 1) {
  return series.map((x, t) => (t - k >= 0 ? r4(x - series[t - k]) : null));
}

/** k-step percentage change (%). */
function pctChange(series, k = 1) {
  return series.map((x, t) => {
    if (t - k < 0) return null;
    const prev = series[t - k];
    return prev ? r4(((x - prev) / prev) * 100) : null;
  });
}

/**
 * Fourier seasonality terms for a given period and harmonic order.
 * For position t: sin/cos(2π·h·t / period) for h = 1..order.
 * @returns {Object} { [`fourier_sin_{period}_{h}`]: …, [`fourier_cos_{period}_{h}`]: … }
 */
function fourierTerms(t, period, order = 2) {
  const out = {};
  for (let h = 1; h <= order; h++) {
    const ang = (2 * Math.PI * h * t) / period;
    out[`fourier_sin_${period}_${h}`] = r4(Math.sin(ang));
    out[`fourier_cos_${period}_${h}`] = r4(Math.cos(ang));
  }
  return out;
}

/** Fourier features for a whole series of length n across several periods. */
function fourierFeatures(n, periods = [12], order = 2) {
  return Array.from({ length: n }, (_, t) => {
    let f = {};
    for (const p of periods) f = { ...f, ...fourierTerms(t, p, order) };
    return f;
  });
}

module.exports = {
  lag, rollingMean, rollingStd, rollingMin, rollingMax, rollingSum,
  rollingZScore, ewma, diff, pctChange, fourierTerms, fourierFeatures,
  _mean: mean, _std: std,
};

// services/forecasting/ets.js
//
// Forecast Platform — Statistical layer. ETS (Error-Trend-Seasonal) with
// automatic form selection by AICc (pure JS).
//
// Fits three candidate state-space forms — Holt's linear trend (A,A,N), damped
// trend (A,Ad,N), and additive Holt-Winters (A,A,A) — scores each by AICc on the
// in-sample one-step errors, and forecasts with the winner. This is the
// "auto-ETS" member that complements the fixed Holt-Winters member.
//
'use strict';

const r0 = (v) => Math.max(0, Math.round(v));

/** AICc from sum-of-squared one-step errors. */
function aicc(sse, n, k) {
  if (n - k - 1 <= 0 || sse <= 0) return Infinity;
  return n * Math.log(sse / n) + (2 * k * n) / (n - k - 1);
}

/** Holt's linear trend (A,A,N). */
function _fitHolt(series, { alpha = 0.4, beta = 0.1 } = {}) {
  if (series.length < 2) return null;
  let level = series[0]; let trend = series[1] - series[0]; let sse = 0;
  for (let t = 1; t < series.length; t++) {
    const pred = level + trend;
    sse += (series[t] - pred) ** 2;
    const prev = level;
    level = alpha * series[t] + (1 - alpha) * (level + trend);
    trend = beta * (level - prev) + (1 - beta) * trend;
  }
  return { sse, k: 2, forecast: (h) => Array.from({ length: h }, (_, i) => level + (i + 1) * trend) };
}

/** Damped trend (A,Ad,N). */
function _fitDamped(series, { alpha = 0.4, beta = 0.1, phi = 0.9 } = {}) {
  if (series.length < 2) return null;
  let level = series[0]; let trend = series[1] - series[0]; let sse = 0;
  for (let t = 1; t < series.length; t++) {
    const pred = level + phi * trend;
    sse += (series[t] - pred) ** 2;
    const prev = level;
    level = alpha * series[t] + (1 - alpha) * (level + phi * trend);
    trend = beta * (level - prev) + (1 - beta) * phi * trend;
  }
  return {
    sse, k: 3,
    forecast: (h) => Array.from({ length: h }, (_, i) => {
      let acc = 0; for (let j = 1; j <= i + 1; j++) acc += Math.pow(phi, j);
      return level + acc * trend;
    }),
  };
}

/** Additive Holt-Winters (A,A,A). */
function _fitHWAdditive(series, period, { alpha = 0.4, beta = 0.1, gamma = 0.2 } = {}) {
  const n = series.length;
  if (n < period * 2) return null;
  let level = series.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const seasonal = series.slice(0, period).map((v) => v - level);
  let trend = (series.slice(period, 2 * period).reduce((s, v) => s + v, 0) / period - level) / period;
  let sse = 0;
  for (let t = 0; t < n; t++) {
    const s = seasonal[t % period];
    const pred = level + trend + s;
    if (t >= period) sse += (series[t] - pred) ** 2;
    const prev = level;
    level = alpha * (series[t] - s) + (1 - alpha) * (level + trend);
    trend = beta * (level - prev) + (1 - beta) * trend;
    seasonal[t % period] = gamma * (series[t] - level) + (1 - gamma) * s;
  }
  return {
    sse, k: 3,
    forecast: (h) => Array.from({ length: h }, (_, i) => level + (i + 1) * trend + seasonal[(n + i) % period]),
  };
}

/** Auto-ETS forecaster: select the candidate with the lowest AICc. */
function etsForecaster(train, horizon, { period = 3 } = {}) {
  const n = train.length;
  if (n < 2) return Array(horizon).fill(Math.max(0, train[n - 1] || 0));

  const candidates = [_fitHolt(train), _fitDamped(train)];
  if (n >= period * 2) candidates.push(_fitHWAdditive(train, period));

  let best = null; let bestScore = Infinity;
  for (const c of candidates) {
    if (!c) continue;
    const score = aicc(c.sse, n, c.k);
    if (score < bestScore) { bestScore = score; best = c; }
  }
  if (!best) {
    const slope = n >= 2 ? (train[n - 1] - train[0]) / (n - 1) : 0;
    return Array.from({ length: horizon }, (_, i) => r0(train[n - 1] + slope * (i + 1)));
  }
  return best.forecast(horizon).map(r0);
}

module.exports = { etsForecaster, aicc };

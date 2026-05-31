// services/forecasting/elasticNet.js
//
// Forecast Platform — ML layer. ElasticNet autoregressive forecaster (pure JS).
//
// Coordinate-descent ElasticNet (L1 + L2) on lagged features — a regularized
// linear ML member that handles correlated lag features (the L2 grouping) while
// pruning weak ones (the L1 sparsity). Same forecastFn signature as the other
// members, so it slots into the ensemble + backtest harness + baseline gate.
//
'use strict';

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const soft = (z, g) => (z > g ? z - g : z < -g ? z + g : 0); // soft-threshold

/**
 * Fit ElasticNet via coordinate descent.
 * @param {number[][]} X  n×p design (no intercept column; centered internally)
 * @param {number[]} y    length n
 * @param {Object} opts { alpha, l1Ratio, iters, tol }
 * @returns {number[]} coef = [intercept, b1..bp]
 */
function fitElasticNet(X, y, { alpha = 0.1, l1Ratio = 0.5, iters = 300, tol = 1e-5 } = {}) {
  const n = X.length;
  const p = X[0].length;
  const yMean = mean(y);
  const yc = y.map((v) => v - yMean);
  const colMean = Array.from({ length: p }, (_, j) => mean(X.map((r) => r[j])));
  const Xc = X.map((r) => r.map((v, j) => v - colMean[j]));
  const normSq = Array.from({ length: p }, (_, j) => Xc.reduce((s, r) => s + r[j] * r[j], 0));

  const b = Array(p).fill(0);
  let r = yc.slice(); // residual = yc - Xc·b (b=0 → yc)
  const l1 = alpha * l1Ratio * n;
  const l2 = alpha * (1 - l1Ratio) * n;

  for (let it = 0; it < iters; it++) {
    let maxChange = 0;
    for (let j = 0; j < p; j++) {
      if (normSq[j] === 0) continue;
      let rho = 0;
      for (let i = 0; i < n; i++) rho += Xc[i][j] * r[i];
      rho += normSq[j] * b[j];                       // partial residual for coord j
      const bjNew = soft(rho, l1) / (normSq[j] + l2);
      const delta = bjNew - b[j];
      if (delta !== 0) {
        for (let i = 0; i < n; i++) r[i] -= Xc[i][j] * delta;
        b[j] = bjNew;
        maxChange = Math.max(maxChange, Math.abs(delta));
      }
    }
    if (maxChange < tol) break;
  }
  const intercept = yMean - colMean.reduce((s, m, j) => s + m * b[j], 0);
  return [intercept, ...b];
}

/** ElasticNet AR forecaster (recursive). Falls back to drift on short history. */
function elasticNetForecaster(train, horizon, { p = 3, alpha = 0.1, l1Ratio = 0.5 } = {}) {
  const n = train.length;
  const order = Math.min(p, Math.max(1, n - 2));
  if (n < order + 2) {
    if (n < 2) return Array(horizon).fill(Math.max(0, train[n - 1] || 0));
    const slope = (train[n - 1] - train[0]) / (n - 1);
    return Array.from({ length: horizon }, (_, i) => Math.max(0, train[n - 1] + slope * (i + 1)));
  }
  const X = []; const y = [];
  for (let t = order; t < n; t++) {
    X.push(Array.from({ length: order }, (_, k) => train[t - 1 - k]));
    y.push(train[t]);
  }
  const scale = Math.max(...train.map(Math.abs), 1);
  const coef = fitElasticNet(X, y, { alpha: alpha * scale, l1Ratio });
  const hist = train.slice();
  const out = [];
  for (let h = 0; h < horizon; h++) {
    let yhat = coef[0];
    for (let k = 1; k <= order; k++) yhat += coef[k] * hist[hist.length - k];
    yhat = Math.max(0, yhat);
    out.push(yhat);
    hist.push(yhat);
  }
  return out;
}

module.exports = { fitElasticNet, elasticNetForecaster };

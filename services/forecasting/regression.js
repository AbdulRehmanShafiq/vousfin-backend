// services/forecasting/regression.js
//
// Forecast Platform — F4. Autoregressive least-squares forecaster (pure JS).
//
// A genuine ML member (AR(p) via ridge-regularized OLS on lagged features),
// same forecastFn signature as the baselines/classical so it slots into the
// ensemble and the backtest harness. It stands in for the LightGBM/CatBoost
// member until the Python inference worker (F8) is provisioned — at which point
// the GBM drops into the same ensemble slot with no interface change.
//
'use strict';

/** Solve A·x = b for small dense A via Gaussian elimination with partial pivot. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) continue;            // singular column → skip (ridge keeps it stable)
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => (Math.abs(M[i][i]) < 1e-12 ? 0 : row[n] / M[i][i]));
}

/** Fit AR(p) coefficients [intercept, b1..bp] by ridge OLS. */
function fitAR(series, p, lambda) {
  const n = series.length;
  const dim = p + 1;
  const A = Array.from({ length: dim }, () => Array(dim).fill(0));
  const g = Array(dim).fill(0);
  for (let t = p; t < n; t++) {
    const row = [1];
    for (let k = 1; k <= p; k++) row.push(series[t - k]);
    for (let a = 0; a < dim; a++) {
      g[a] += row[a] * series[t];
      for (let b = 0; b < dim; b++) A[a][b] += row[a] * row[b];
    }
  }
  for (let d = 1; d < dim; d++) A[d][d] += lambda;          // ridge on slopes, not intercept
  return solve(A, g);
}

/**
 * AR forecaster. Recursively predicts `horizon` steps; falls back to a simple
 * drift line when the series is too short to fit.
 */
function arForecaster(train, horizon, { p = 2 } = {}) {
  const n = train.length;
  const order = Math.min(p, Math.max(1, n - 2));
  if (n < order + 2) {                                       // too short → drift fallback
    if (n < 2) return Array(horizon).fill(Math.max(0, train[n - 1] || 0));
    const slope = (train[n - 1] - train[0]) / (n - 1);
    return Array.from({ length: horizon }, (_, i) => Math.max(0, train[n - 1] + slope * (i + 1)));
  }
  const scale = Math.max(...train.map(Math.abs), 1);
  const coef = fitAR(train, order, 1e-3 * scale);
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

module.exports = { arForecaster, fitAR, solve };

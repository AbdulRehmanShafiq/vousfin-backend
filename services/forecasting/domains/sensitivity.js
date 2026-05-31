// services/forecasting/domains/sensitivity.js
//
// Forecast Platform — F6. Macroeconomic sensitivity via OLS regression (pure).
//
// Estimates how a target (e.g. revenue) responds to a macro factor (e.g. FX rate,
// inflation): the regression slope (beta), the goodness of fit (R²), and the
// elasticity (% change in target per % change in factor). Used to stress-test
// forecasts against macro scenarios.
//
'use strict';

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const r4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);

/**
 * Simple OLS of y on x.
 * @returns {{ beta, intercept, r2, elasticity, n, correlation }}  null fields when undefined.
 */
function regress(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return { beta: null, intercept: null, r2: null, elasticity: null, n, correlation: null };
  const xs = x.slice(0, n); const ys = y.slice(0, n);
  const mx = mean(xs); const my = mean(ys);
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return { beta: null, intercept: null, r2: null, elasticity: null, n, correlation: null };
  const beta = sxy / sxx;
  const intercept = my - beta * mx;
  // R² = (explained / total) = correlation²
  const corr = (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : 0;
  const r2 = corr * corr;
  const elasticity = (my !== 0) ? beta * (mx / my) : null;
  return { beta: r4(beta), intercept: r4(intercept), r2: r4(r2), elasticity: r4(elasticity), n, correlation: r4(corr) };
}

/** Apply a regression to project the target under a factor scenario. */
function project(model, factorValue) {
  if (model.beta == null) return null;
  return Math.round(model.intercept + model.beta * factorValue);
}

module.exports = { regress, project };

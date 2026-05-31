// services/forecasting/explainability/scenario.js
//
// Forecast Platform — F7. What-if scenario engine (pure).
//
// Applies driver shocks to a series, refits the supplied forecaster, and
// compares the scenario path to the base — answering "what happens to the
// forecast if revenue is +20% / costs are -10% / growth slows".
//
'use strict';

const r0 = (v) => Math.round(Number(v) || 0);

/** Multiply/offset a forecast directly (cheap shock, no refit). */
function applyShock(predicted, { multiplier = 1, additive = 0 } = {}) {
  return predicted.map((v) => Math.max(0, r0(v * multiplier + additive)));
}

/**
 * Refit-based what-if: transform the historical series, rebuild the forecaster
 * via `buildForecastFn(transformedSeries)`, and forecast — so the scenario
 * captures the changed dynamics, not just a flat rescale.
 * @param {number[]} series
 * @param {(s:number[])=>((train:number[],h:number)=>number[])} buildForecastFn
 * @param {(v:number, i:number)=>number} transform
 * @param {number} horizon
 */
function whatIf(series, buildForecastFn, transform, horizon) {
  const transformed = series.map((v, i) => Math.max(0, transform(v, i)));
  const forecastFn = buildForecastFn(transformed);
  return forecastFn(transformed, horizon).map(r0);
}

/** Per-step comparison of a scenario path against the base forecast. */
function compare(base, scenario) {
  return base.map((b, i) => {
    const s = scenario[i] != null ? scenario[i] : b;
    return { period: i + 1, base: r0(b), scenario: r0(s), delta: r0(s - b), deltaPct: b ? Math.round(((s - b) / b) * 1000) / 10 : 0 };
  });
}

/** Sweep a multiplier grid → forecast under each (sensitivity curve). */
function sweep(series, buildForecastFn, multipliers, horizon) {
  return multipliers.map((m) => ({
    multiplier: m,
    forecast: whatIf(series, buildForecastFn, (v) => v * m, horizon),
  }));
}

module.exports = { applyShock, whatIf, compare, sweep };

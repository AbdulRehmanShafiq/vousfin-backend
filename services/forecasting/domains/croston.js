// services/forecasting/domains/croston.js
//
// Forecast Platform — F6. Croston's method for intermittent demand (pure).
//
// Standard ensemble/ETS models degrade on demand series full of zeros (slow-moving
// inventory). Croston separately smooths the non-zero demand SIZE and the INTERVAL
// between demands, forecasting rate = size / interval — the institutional choice
// for intermittent inventory demand.
//
'use strict';

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Croston's intermittent-demand forecast.
 * @param {number[]} demand  per-period demand (may contain zeros)
 * @param {Object} opts { alpha, horizon }
 * @returns {{ forecast:number[], rate, demandSize, interval, intermittent }}
 */
function croston(demand, { alpha = 0.1, horizon = 1 } = {}) {
  const d = (demand || []).map((v) => Math.max(0, Number(v) || 0));
  const nonZero = d.filter((v) => v > 0);
  if (!nonZero.length) {
    return { forecast: Array(horizon).fill(0), rate: 0, demandSize: 0, interval: null, intermittent: true };
  }
  let z = null;  // smoothed demand size
  let x = null;  // smoothed interval
  let q = 1;     // periods since last non-zero demand
  for (let i = 0; i < d.length; i++) {
    if (d[i] > 0) {
      if (z === null) { z = d[i]; x = q; }
      else { z = alpha * d[i] + (1 - alpha) * z; x = alpha * q + (1 - alpha) * x; }
      q = 1;
    } else {
      q += 1;
    }
  }
  const rate = (z != null && x > 0) ? z / x : 0;
  const zeros = d.length - nonZero.length;
  return {
    forecast: Array(horizon).fill(r2(Math.max(0, rate))),
    rate: r2(rate), demandSize: r2(z), interval: r2(x),
    intermittent: zeros / d.length > 0.3,
  };
}

module.exports = { croston };

// services/forecasting/domains/liquidityStress.js
//
// Forecast Platform — F6. Liquidity stress via Monte-Carlo simulation (pure).
//
// Simulates the business's future cash position under stochastic monthly net-cash
// shocks (fit from history), then reports Value-at-Risk, the probability of
// running out of cash (ruin), and the distribution of ending balances. Uses a
// seeded RNG so results are deterministic and unit-testable.
//
'use strict';

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const std = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller. */
function gaussian(rng) {
  let u = 0; let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Monte-Carlo liquidity stress test.
 * @param {number} currentCash starting cash position
 * @param {number[]} netChanges historical per-period net cash movements
 * @param {Object} opts { horizon, sims, alpha, seed }
 * @returns {{ currentCash, horizon, sims, mu, sigma, expectedEnding, var, varEnding, worstCaseEnding, ruinProbability, percentiles }}
 */
function monteCarloVaR(currentCash, netChanges, opts = {}) {
  const { horizon = 6, sims = 2000, alpha = 0.05, seed = 12345 } = opts;
  const mu = mean(netChanges);
  // Floor volatility so a flat history still produces a non-degenerate stress band.
  const sigma = std(netChanges) || Math.max(Math.abs(mu) * 0.25, Math.abs(currentCash) * 0.05, 1);
  const rng = mulberry32(seed);

  const endings = [];
  let ruin = 0;
  for (let s = 0; s < sims; s++) {
    let cash = currentCash;
    let minCash = cash;
    for (let h = 0; h < horizon; h++) {
      cash += mu + sigma * gaussian(rng);
      if (cash < minCash) minCash = cash;
    }
    endings.push(cash);
    if (minCash < 0) ruin++;
  }
  endings.sort((a, b) => a - b);
  const q = (p) => endings[Math.min(endings.length - 1, Math.max(0, Math.floor(p * sims)))];
  const varEnding = q(alpha);

  return {
    currentCash: r2(currentCash),
    horizon, sims,
    mu: r2(mu), sigma: r2(sigma),
    expectedEnding: r2(mean(endings)),
    varEnding: r2(varEnding),                                  // alpha-quantile ending cash
    valueAtRisk: r2(Math.max(0, currentCash - varEnding)),     // potential loss vs today at (1-alpha) confidence
    worstCaseEnding: r2(endings[0]),
    ruinProbability: r2(ruin / sims),                          // P(cash goes negative at any point)
    confidence: Math.round((1 - alpha) * 100),
    percentiles: { p5: r2(q(0.05)), p25: r2(q(0.25)), p50: r2(q(0.5)), p75: r2(q(0.75)), p95: r2(q(0.95)) },
  };
}

module.exports = { monteCarloVaR, mulberry32, gaussian };

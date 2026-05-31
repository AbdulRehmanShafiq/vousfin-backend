// services/forecasting/explainability/attribution.js
//
// Forecast Platform — F7. Forecast attribution (pure).
//
// Two EXACT decompositions (no approximation needed):
//   1. ensembleAttribution — splits the ensemble point forecast into each
//      member's weighted contribution (which model drove the number).
//   2. linearContributions — for the AR / linear member, contribution_i =
//      coef_i × feature_i is the exact Shapley value of a linear model (the
//      principled stand-in for SHAP until the Python worker lands in F8).
//
'use strict';

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const r4 = (v) => Math.round((Number(v) || 0) * 10000) / 10000;

/**
 * Decompose the ensemble's next-step forecast into member contributions.
 * @param {Object<string,number>} weights      member → weight
 * @param {Object<string,number>} memberPoint  member → its next-step forecast
 * @returns {{ total, members:Array<{name,weight,value,contribution,pct}> }}
 */
function ensembleAttribution(weights, memberPoint) {
  const rows = [];
  let total = 0;
  for (const [name, w] of Object.entries(weights || {})) {
    const value = Number(memberPoint?.[name]) || 0;
    const contribution = (Number(w) || 0) * value;
    total += contribution;
    rows.push({ name, weight: r4(w), value: r2(value), contribution: r2(contribution) });
  }
  return {
    total: r2(total),
    members: rows
      .map((r) => ({ ...r, pct: total ? Math.round((r.contribution / total) * 100) : 0 }))
      .sort((a, b) => b.contribution - a.contribution),
  };
}

/**
 * Exact linear feature attribution for an AR/OLS model.
 * @param {number[]} coef      [intercept, b1..bp]
 * @param {number[]} features  [f1..fp] (the lag values feeding the next step)
 * @param {string[]} [names]
 * @returns {{ base, total, drivers:Array<{name,coef,feature,contribution,pct,direction}> }}
 */
function linearContributions(coef, features, names) {
  const base = Number(coef?.[0]) || 0;
  const drivers = [];
  for (let i = 1; i < (coef || []).length; i++) {
    const feature = Number(features?.[i - 1]) || 0;
    const contribution = (Number(coef[i]) || 0) * feature;
    drivers.push({
      name: (names && names[i - 1]) || `lag_${i}`,
      coef: r4(coef[i]), feature: r2(feature), contribution: r2(contribution),
    });
  }
  const total = base + drivers.reduce((s, d) => s + d.contribution, 0);
  return {
    base: r2(base), total: r2(total),
    drivers: drivers
      .map((d) => ({
        ...d,
        pct: total ? Math.round((d.contribution / total) * 100) : 0,
        direction: d.contribution >= 0 ? 'up' : 'down',
      }))
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)),
  };
}

module.exports = { ensembleAttribution, linearContributions };

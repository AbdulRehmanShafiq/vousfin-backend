// utils/stpMetrics.helper.js — pure straight-through-processing metrics
// (Intelligence Roadmap Phase 3: Continuous Close & STP).
//
// The STP scorecard is the north-star automation measure: of the financial
// work that happened, how much did VousFin do by itself? Four capabilities:
//   posting        — journal entries auto-posted (vs all user-originated posts)
//   matching       — bills that 3-way-matched clean without human override
//   reconciliation — bank statement lines the engine matched by itself
//   categorization — AI classifications the user accepted without correction
//
// A capability with NO activity contributes null, not 0 — "no bills this
// quarter" is absence of signal, not a 0% automation failure. The composite
// stpScore is the mean over capabilities that actually had activity.
'use strict';

const CAPABILITIES = ['posting', 'matching', 'reconciliation', 'categorization'];
const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * @param {Object<string,{total:number, automated:number}>} counts per capability
 * @returns {{posting,matching,reconciliation,categorization: {total,automated,rate}, stpScore: number|null}}
 */
function computeStpScorecard(counts = {}) {
  const out = {};
  const activeRates = [];
  for (const cap of CAPABILITIES) {
    const total = Math.max(0, Number(counts[cap]?.total) || 0);
    const automated = Math.min(total, Math.max(0, Number(counts[cap]?.automated) || 0));
    const rate = total === 0 ? null : round4(automated / total);
    if (rate !== null) activeRates.push(rate);
    out[cap] = { total, automated, rate };
  }
  out.stpScore = activeRates.length === 0
    ? null
    : round4(activeRates.reduce((s, r) => s + r, 0) / activeRates.length);
  return out;
}

module.exports = { computeStpScorecard, CAPABILITIES };

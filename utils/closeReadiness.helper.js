// utils/closeReadiness.helper.js — pure close-readiness scoring (Intelligence
// Roadmap Phase 3: Continuous Close).
//
// Takes a list of checklist items {key, ok, count, weight} and produces a
// weighted 0–100 readiness score. `ready` requires EVERY check to pass — the
// score exists to show progress, not to let a 90% month close with a broken
// ledger. Blockers are the failing items, heaviest first.
'use strict';

/**
 * @param {Array<{key:string, ok:boolean, count?:number, weight?:number}>} checks
 * @returns {{score:number, ready:boolean, blockers:Array}}
 */
function scoreReadiness(checks = []) {
  if (!Array.isArray(checks) || checks.length === 0) {
    return { score: 0, ready: false, blockers: [] };
  }
  let totalWeight = 0;
  let passedWeight = 0;
  const blockers = [];
  for (const c of checks) {
    const weight = Number(c.weight) > 0 ? Number(c.weight) : 1;
    totalWeight += weight;
    if (c.ok) passedWeight += weight;
    else blockers.push({ ...c, weight });
  }
  blockers.sort((a, b) => b.weight - a.weight);
  return {
    score: Math.round((passedWeight / totalWeight) * 100),
    ready: blockers.length === 0,
    blockers,
  };
}

module.exports = { scoreReadiness };

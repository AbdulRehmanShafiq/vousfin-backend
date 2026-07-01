// utils/aiCalibration.helper.js — pure confidence recalibration (Intelligence
// Roadmap Phase 1).
//
// Turns measured AI-decision outcomes into rates, and derives an EFFECTIVE
// auto-post threshold from a tenant's real reversal record. Direction is
// deliberately one-way: calibration can only make auto-post MORE conservative
// (raise the bar) when reversals occur — it NEVER lowers below the static base.
// Correctness > convenience: the 0.98 bar is a floor, not a target to erode.
'use strict';

const round4 = (n) => Math.round(n * 10000) / 10000;
const MAX_THRESHOLD = 0.995; // ceiling: never demand a score real parses can't reach

/**
 * @param {{pending?:number, accepted?:number, corrected?:number, reversed?:number}} counts
 * @returns {{total, resolved, pending, accepted, corrected, reversed, acceptanceRate, correctionRate, reversalRate}}
 */
function computeRates({ pending = 0, accepted = 0, corrected = 0, reversed = 0 } = {}) {
  const resolved = accepted + corrected + reversed;
  const total = resolved + pending;
  const rate = (n) => (resolved === 0 ? 0 : round4(n / resolved));
  return {
    total, resolved, pending, accepted, corrected, reversed,
    acceptanceRate: rate(accepted),
    correctionRate: rate(corrected),
    reversalRate: rate(reversed),
  };
}

/**
 * Effective auto-post threshold given a tenant's measured outcomes.
 * @param {number} base   the static AUTO_POST_THRESHOLD (e.g. 0.98)
 * @param {object} rates  output of computeRates
 * @param {{minSamples?:number}} opts
 * @returns {number} a value in [base, 0.995]
 */
function effectiveAutoPostThreshold(base, rates, { minSamples = 20 } = {}) {
  if (!rates || rates.resolved < minSamples) return base;
  const penalty = rates.reversalRate * 0.2; // reversals tighten the bar
  const raised = round4(base + penalty);
  return Math.min(MAX_THRESHOLD, Math.max(base, raised));
}

module.exports = { computeRates, effectiveAutoPostThreshold };

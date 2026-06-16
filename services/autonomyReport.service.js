// services/autonomyReport.service.js
//
// Autonomy roadmap Phase 1 — the Autonomy Report: the trust instrument. Combines
// the current autonomy posture (per-capability dial) with measured accuracy from
// the feedback loop, and recommends dialing each capability up or down. This is
// what justifies granting more autonomy — and what keeps it honest.
//
'use strict';
const policy = require('./autonomyPolicy.service');
const feedback = require('./feedback.service');
const { AUTONOMY_CAPABILITIES, AUTONOMY_LEVELS } = require('../config/constants');

const MIN_SAMPLE = 10;           // don't recommend a change without enough evidence
const UP_ACCURACY = 0.95;        // strong track record → dial up
const DOWN_ACCURACY = 0.80;      // shaky → dial back
const L = AUTONOMY_LEVELS;
const NEXT_UP = { [L.OBSERVE]: L.SUGGEST, [L.SUGGEST]: L.COPILOT, [L.COPILOT]: L.AUTOPILOT };
const pct = (a) => `${Math.round((a || 0) * 100)}%`;

/** Suggest a dial change for one capability from its track record (or null). */
function recommend(currentLevel, stats) {
  if (!stats || stats.total < MIN_SAMPLE) return null;
  const acc = stats.accuracy;

  if (acc >= UP_ACCURACY && NEXT_UP[currentLevel]) {
    return { to: NEXT_UP[currentLevel], direction: 'up',
      reason: `${pct(acc)} accurate over ${stats.total} decisions — ready to trust it further.` };
  }
  if (acc < DOWN_ACCURACY && (currentLevel === L.COPILOT || currentLevel === L.AUTOPILOT)) {
    return { to: L.SUGGEST, direction: 'down',
      reason: `Only ${pct(acc)} accurate over ${stats.total} decisions — dial back to Suggest until it improves.` };
  }
  return null;
}

/** @returns {Promise<{summary:object, capabilities:object[]}>} */
async function getReport(businessId) {
  const [pol, stats] = await Promise.all([policy.getPolicy(businessId), feedback.getStats(businessId)]);

  const capabilities = AUTONOMY_CAPABILITIES.map((cap) => {
    const s = stats[cap] || { total: 0, approved: 0, rejected: 0, edited: 0, accuracy: 0 };
    const level = (pol.capabilities[cap] && pol.capabilities[cap].level) || L.SUGGEST;
    return { capability: cap, level, total: s.total, approved: s.approved, rejected: s.rejected, edited: s.edited, accuracy: s.accuracy, recommendation: recommend(level, s) };
  });

  const totalDecisions = capabilities.reduce((n, c) => n + c.total, 0);
  const totalApproved  = capabilities.reduce((n, c) => n + c.approved, 0);

  return {
    summary: {
      totalDecisions,
      accuracy: totalDecisions > 0 ? totalApproved / totalDecisions : 0,
      capabilitiesBeyondSuggest: capabilities.filter(c => c.level === L.COPILOT || c.level === L.AUTOPILOT).length,
      pendingRecommendations: capabilities.filter(c => c.recommendation).length,
    },
    capabilities,
  };
}

module.exports = { getReport, recommend };

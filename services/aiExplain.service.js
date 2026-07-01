// services/aiExplain.service.js — Explainability Everywhere (Intelligence
// Roadmap Phase 2). Loads a Phase-0 decision (tenant-scoped) and renders a
// grounded, plain-language "why". The explanation is deterministic templating
// over the stored record (see aiExplain.helper) — faithful by construction.
'use strict';
const aiDecisionService = require('./aiDecision.service');
const { buildExplanation } = require('../utils/aiExplain.helper');

/**
 * @returns {Promise<{decision:object, explanation:{text,citedValues,faithful}}|null>}
 */
async function explainById(id, businessId) {
  const decision = await aiDecisionService.getById(id, businessId);
  if (!decision) return null;
  return { decision, explanation: buildExplanation(decision) };
}

module.exports = { explainById };

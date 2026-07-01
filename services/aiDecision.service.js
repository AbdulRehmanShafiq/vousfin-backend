// services/aiDecision.service.js — safe front door to the AI Decision Ledger.
//
// record()/recordOutcome() are OBSERVABILITY: they must never throw into or slow
// an AI/accounting path. Any failure is logged and swallowed. list()/getById()
// are the read surface for the lineage UI (they propagate errors normally).
'use strict';
const repo = require('../repositories/aiDecision.repository');
const { buildDecisionRecord } = require('../utils/aiDecision.helper');
const logger = require('../config/logger');

class AIDecisionService {
  /** Record a new AI decision. Never throws — returns the doc or null. */
  async record(businessId, kind, payload) {
    try {
      const rec = buildDecisionRecord(businessId, kind, payload);
      return await repo.create(rec);
    } catch (err) {
      logger.warn(`[aiDecision] record failed (non-fatal): ${err.message}`);
      return null;
    }
  }

  /** Set a decision's one-time outcome. Never throws. */
  async recordOutcome(decisionId, businessId, outcome, correctedTo = null) {
    if (!decisionId) return;
    try {
      await repo.setOutcome(decisionId, businessId, outcome, correctedTo);
    } catch (err) {
      logger.warn(`[aiDecision] recordOutcome failed (non-fatal): ${err.message}`);
    }
  }

  list(businessId, filters = {}) { return repo.findByBusiness(businessId, filters); }
  getById(id, businessId) { return repo.findByIdForBusiness(id, businessId); }
}

module.exports = new AIDecisionService();

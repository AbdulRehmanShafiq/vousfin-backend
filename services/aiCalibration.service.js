// services/aiCalibration.service.js — measured confidence recalibration
// (Intelligence Roadmap Phase 1).
//
// Reads a tenant's real AI-decision outcomes (from the Phase 0 ledger) and
// derives acceptance/correction/reversal rates and an effective auto-post
// threshold. Read-only and never-throwing: a metrics failure can never break an
// AI/accounting path — it simply reports zero signal (→ base threshold).
'use strict';
const repo = require('../repositories/aiDecision.repository');
const { computeRates, effectiveAutoPostThreshold } = require('../utils/aiCalibration.helper');
const logger = require('../config/logger');

/**
 * @returns {Promise<ReturnType<typeof computeRates>>} acceptance/correction/reversal stats
 */
async function computeAcceptanceStats(businessId, { kind } = {}) {
  try {
    const counts = await repo.outcomeBreakdown(businessId, kind);
    return computeRates(counts);
  } catch (err) {
    logger.warn(`[aiCalibration] stats failed (non-fatal): ${err.message}`);
    return computeRates({});
  }
}

/**
 * Effective auto-post threshold for a tenant — never below `base`.
 * @returns {Promise<number>}
 */
async function getEffectiveAutoPostThreshold(businessId, base) {
  try {
    const stats = await computeAcceptanceStats(businessId, { kind: 'parse' });
    return effectiveAutoPostThreshold(base, stats);
  } catch (err) {
    logger.warn(`[aiCalibration] threshold failed (non-fatal): ${err.message}`);
    return base;
  }
}

module.exports = { computeAcceptanceStats, getEffectiveAutoPostThreshold };

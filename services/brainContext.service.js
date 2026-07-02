// services/brainContext.service.js — the Unified Financial Brain's shared
// context (Intelligence Roadmap Phase 6).
//
// One tenant-scoped, read-only surface that aggregates what the individual
// intelligence subsystems each know — the learned-preference store, measured
// calibration, automation depth (STP), close readiness, and business health —
// so every agent (and the UI) reasons from the SAME picture of the business
// instead of each keeping its own partial view. Derivation only: this service
// stores nothing and can never disagree with the sources. Each section is
// fault-isolated: a failing source reports null, never breaks the brain.
'use strict';
const calibration = require('./aiCalibration.service');
const stpScorecard = require('./stpScorecard.service');
const closeReadiness = require('./closeReadiness.service');
const businessHealth = require('./businessHealth.service');
const EntityMemory = require('../models/EntityMemory.model');
const logger = require('../config/logger');

async function safeSection(name, fn) {
  try { return await fn(); }
  catch (err) {
    logger.warn(`[brainContext] ${name} section failed (non-fatal): ${err.message}`);
    return null;
  }
}

/**
 * @returns {Promise<{learning, calibration, automation, close, health, asOf}>}
 */
async function getContext(businessId) {
  const [learning, calibrationSection, automation, close, health] = await Promise.all([
    safeSection('learning', async () => {
      const [totalLearnedFacts, recent] = await Promise.all([
        EntityMemory.countDocuments({ businessId }),
        EntityMemory.find({ businessId }).sort({ lastSeen: -1 }).limit(10).lean(),
      ]);
      return {
        totalLearnedFacts,
        recent: recent.map((m) => ({ kind: m.kind, key: m.key, hits: m.hits, lastSeen: m.lastSeen })),
      };
    }),
    safeSection('calibration', async () => {
      const [stats, effectiveAutoPostThreshold] = await Promise.all([
        calibration.computeAcceptanceStats(businessId, { kind: 'parse' }),
        calibration.getEffectiveAutoPostThreshold(businessId, require('./nlParser/utils/confidenceCalculator').AUTO_POST_THRESHOLD),
      ]);
      return { ...stats, effectiveAutoPostThreshold };
    }),
    safeSection('automation', () => stpScorecard.getScorecard(businessId, { days: 90 })),
    safeSection('close', () => closeReadiness.getReadiness(businessId)),
    safeSection('health', async () => {
      const h = await businessHealth.getHealthScore(businessId);
      if (!h || h.insufficient) return null;
      return { overall: h.overall, level: h.level, metrics: h.metrics || null };
    }),
  ]);

  return {
    learning,
    calibration: calibrationSection,
    automation,
    close,
    health,
    asOf: new Date().toISOString(),
  };
}

module.exports = { getContext };

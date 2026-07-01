// services/advisor.service.js — the Proactive AI CFO feed (Intelligence
// Roadmap Phase 4).
//
// Gathers live signals from the tenant's REAL engines — 13-week cash forecast,
// AR aging, business health, STP scorecard — and turns them into ranked,
// plain-language, executable recommendations (advisor.helper is pure and
// grounded by construction). Signal gathering is fault-isolated: one engine
// failing drops only its signal, never the feed. Each non-empty advisory run
// is recorded in the AI Decision Ledger (kind 'recommend') so advice has the
// same lineage as every other AI action.
'use strict';
const thirteenWeekCashFlow = require('./thirteenWeekCashFlow.service');
const reportService = require('./report.service');
const businessHealth = require('./businessHealth.service');
const stpScorecard = require('./stpScorecard.service');
const aiDecisionService = require('./aiDecision.service');
const { buildRecommendations } = require('../utils/advisor.helper');
const logger = require('../config/logger');

async function safeSignal(name, fn) {
  try { return await fn(); }
  catch (err) {
    logger.warn(`[advisor] ${name} signal failed (non-fatal): ${err.message}`);
    return null;
  }
}

/**
 * @returns {Promise<{recommendations:Array, asOf:string}>}
 */
async function getRecommendations(businessId) {
  const [liquidityAlerts, receivableAging, healthScore, stp] = await Promise.all([
    safeSignal('liquidity', async () => {
      const alerts = await thirteenWeekCashFlow.getLiquidityAlerts(businessId);
      return (alerts || []).map((w) => ({ weekStart: w.weekStartDate, projectedClosing: w.closingBalance }));
    }),
    safeSignal('receivables', async () => {
      const aging = await reportService.getAgingReport(businessId, 'receivable');
      const b61 = aging?.buckets?.days_61_90 || { total: 0, items: [] };
      const b90 = aging?.buckets?.days_over_90 || { total: 0, items: [] };
      return {
        over60Total: (b61.total || 0) + (b90.total || 0),
        over60Count: (b61.items?.length || 0) + (b90.items?.length || 0),
      };
    }),
    safeSignal('health', async () => {
      const h = await businessHealth.getHealthScore(businessId);
      if (!h || h.insufficient || !Number.isFinite(h.overall)) return null;
      return { score: h.overall };
    }),
    safeSignal('stp', () => stpScorecard.getScorecard(businessId)),
  ]);

  const recommendations = buildRecommendations({
    liquidityAlerts: liquidityAlerts || [],
    receivableAging: receivableAging || {},
    healthScore: healthScore || undefined,
    stp: stp || undefined,
  });

  // Lineage: an advisory that said something is an AI decision like any other.
  if (recommendations.length > 0) {
    await aiDecisionService.record(businessId, 'recommend', {
      inputsSummary: `Advisory scan: ${recommendations.map((r) => r.id).join(', ')}`,
      candidates: recommendations.map((r) => r.id),
      decision: { recommendations: recommendations.map(({ id, severity, title }) => ({ id, severity, title })) },
      model: 'advisor-rules-v1',
      promptVersion: 'advisor-v1',
    });
  }

  return { recommendations, asOf: new Date().toISOString() };
}

module.exports = { getRecommendations };

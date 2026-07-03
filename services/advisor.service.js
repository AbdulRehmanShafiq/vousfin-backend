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
const { parseWhatIf, projectAffordability } = require('../utils/whatIf.helper');
const logger = require('../config/logger');

const fmtRs = (n) => `Rs ${Math.round(Math.abs(Number(n) || 0)).toLocaleString('en-PK')}`;
const mo = (n) => (n == null ? 'unknown' : `${n} month${n === 1 ? '' : 's'}`);

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

/**
 * Conversational what-if — "can I afford to hire 2 people at Rs 60k?" → a
 * grounded runway projection from the tenant's REAL cash + burn. Never invents
 * numbers; when it can't ground the question it says so and asks for detail.
 * Framing stays "here's what your runway does", not "you should".
 * @returns {Promise<{understood:boolean, answer:string, projection?:object, parsed:object}>}
 */
async function answerWhatIf(businessId, question) {
  const parsed = parseWhatIf(question);

  if (parsed.kind === 'unknown') {
    return { understood: false, parsed, answer: "I can only answer money questions I can ground in your numbers — try asking about hiring (\"can I afford to hire 2 people at Rs 60,000?\") or spending (\"what if I spend 50,000 a month on marketing?\")." };
  }
  if (parsed.monthlyDelta == null) {
    return { understood: false, parsed, answer: `Tell me the monthly pay per person and I'll project it — e.g. "hire ${parsed.count || 2} people at Rs 60,000 each".` };
  }

  let financials = { cashBalance: 0, monthlyBurn: 0 };
  try {
    const h = await businessHealth.getHealthScore(businessId);
    if (h && !h.insufficient && h.metrics) {
      financials = { cashBalance: h.metrics.cashBalance || 0, monthlyBurn: h.metrics.monthlyBurn || 0 };
    }
  } catch (err) { logger.warn(`[advisor] what-if health load failed: ${err.message}`); }

  const projection = projectAffordability(financials, parsed.monthlyDelta);
  const what = parsed.kind === 'hire' ? `hiring ${parsed.count} (${fmtRs(parsed.monthlyDelta)}/month)` : `spending an extra ${fmtRs(parsed.monthlyDelta)}/month`;

  let answer;
  if (projection.runwayAfter == null) {
    answer = `I don't have enough cash/spending history yet to project ${what}. Record a few months of activity and ask again.`;
  } else if (projection.affordable) {
    answer = `Yes — ${what} takes your cash runway from ${mo(projection.runwayBefore)} to ${mo(projection.runwayAfter)}, which still clears a healthy 6-month buffer. Based on ${fmtRs(financials.cashBalance)} cash and ${fmtRs(financials.monthlyBurn)}/month current spend.`;
  } else {
    answer = `Careful — ${what} would cut your cash runway from ${mo(projection.runwayBefore)} to ${mo(projection.runwayAfter)}, below a comfortable 6-month buffer. Based on ${fmtRs(financials.cashBalance)} cash and ${fmtRs(financials.monthlyBurn)}/month current spend.`;
  }

  await aiDecisionService.record(businessId, 'recommend', {
    inputsSummary: `What-if: ${parsed.kind} — ${String(question).slice(0, 200)}`,
    decision: { parsed, projection },
    model: 'whatif-rules-v1', promptVersion: 'whatif-v1',
  });

  return { understood: true, answer, projection, parsed, asOf: new Date().toISOString() };
}

module.exports = { getRecommendations, answerWhatIf };

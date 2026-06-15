// services/commandCenter.service.js
//
// Autonomy roadmap Phase 0.3 — the one inbox. Aggregates, in a single unified
// shape, the actionable proposed actions (from the router) and the existing
// "needs attention" insights (anomalies, forecast signals, finance + trend
// alerts) — non-invasively, without changing those systems. Actionable items
// sort ahead of informational ones.
//
'use strict';
const proactive = require('./proactiveInsights.service');
const repo = require('../repositories/proposedAction.repository');

// Map an existing insight source → the agent capability it belongs under.
const SOURCE_CAPABILITY = {
  anomaly:         'bookkeeping',
  'trend-monitor': 'advisory',
  finance:         'advisory',
  forecast:        'advisory',
};

function fromInsight(it) {
  return {
    id:          it.id,
    kind:        'insight',
    actionable:  false,
    capability:  SOURCE_CAPABILITY[it.source] || 'advisory',
    level:       it.level || 'info',
    title:       it.title,
    summary:     it.message || '',
    actionLabel: it.action || 'Open',
    actionTo:    it.actionTo || null,
    source:      it.source,
  };
}

function fromAction(a) {
  return {
    id:         String(a._id),
    kind:       'action',
    actionable: true,
    capability: a.capability,
    level:      'info',
    title:      a.title || a.type,
    summary:    a.summary || a.rationale || '',
    rationale:  a.rationale || '',
    citations:  a.citations || [],
    confidence: a.confidence,
    type:       a.type,
  };
}

/**
 * The unified inbox for a business.
 * @returns {Promise<{items:object[], counts:object, generatedAt:string}>}
 */
async function getInbox(businessId) {
  const [na, actions] = await Promise.all([
    proactive.getNeedsAttention(businessId).catch(() => ({ items: [] })),
    repo.inbox(businessId).catch(() => []),
  ]);

  const insights = (na.items || []).map(fromInsight);
  const acts     = (actions || []).map(fromAction);

  // Actionable first, then insights ordered by urgency.
  const order = { critical: 0, warning: 1, info: 2 };
  insights.sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3));
  const items = [...acts, ...insights];

  const counts = {
    actions:  acts.length,
    insights: insights.length,
    critical: insights.filter(i => i.level === 'critical').length,
    warning:  insights.filter(i => i.level === 'warning').length,
    total:    items.length,
  };

  return { items, counts, generatedAt: new Date().toISOString() };
}

module.exports = { getInbox };

/**
 * Proactive Insights Service — H6 ("Needs attention" feed)
 *
 * ONE ranked, de-duplicated action feed merged from every signal source the
 * platform already produces, so the user has a single place that answers
 * "what needs me right now?" instead of scattered panels:
 *
 *   • financialIntelligence.getFinancialInsights — unusual spending, tax risk,
 *     cash-flow warnings (current ledger state)
 *   • businessHealth.getForwardOutlook           — projected cash shortfall,
 *     revenue decline, margin compression (forward-looking)
 *   • anomaly risk                               — flagged unusual transactions
 *
 * Each item is normalised to { id, source, level, title, message, action,
 * actionTo }, de-duplicated by title (highest severity wins), and ranked
 * critical → warning → info. The merge/rank/action logic is pure and unit-tested.
 */
'use strict';

const financialIntelligence = require('./financialIntelligence.service');
const businessHealth = require('./businessHealth.service');

/* ════════════════════════════════════════════════════════════════════════════
   PURE HELPERS (no I/O — unit tested)
════════════════════════════════════════════════════════════════════════════ */

const LEVELS = new Set(['critical', 'warning', 'info']);
const RANK = { critical: 0, warning: 1, info: 2 };

function normalizeLevel(level) {
  const l = String(level || '').toLowerCase();
  if (LEVELS.has(l)) return l;
  if (l === 'danger' || l === 'high' || l === 'error') return 'critical';
  if (l === 'medium' || l === 'warn') return 'warning';
  return 'info';
}

/** Map a signal to a concrete next action + route, by keyword. Returns {} if none. */
function actionFor({ id = '', title = '', message = '' } = {}) {
  const hay = `${id} ${title} ${message}`.toLowerCase();
  const has = (...words) => words.some((w) => hay.includes(w));

  if (has('anomal', 'unusual transaction', 'fraud')) return { action: 'Review flagged transactions', actionTo: '/ai-analyst/anomalies' };
  if (has('receivable', 'overdue invoice', 'customers owe', 'collect')) return { action: 'Review receivables', actionTo: '/sales/receivables' };
  if (has('payable', 'bill due', 'vendors')) return { action: 'Review payables', actionTo: '/purchases/payables' };
  if (has('tax', 'gst', 'vat', 'wht', 'filing')) return { action: 'Open reports', actionTo: '/financial-reports' };
  if (has('cash', 'runway', 'shortfall', 'liquid')) return { action: 'See forecast', actionTo: '/ai/forecast' };
  if (has('revenue', 'sales', 'margin', 'profit', 'decline')) return { action: 'See forecast', actionTo: '/ai/forecast' };
  if (has('spend', 'expense', 'burn', 'cost')) return { action: 'Open reports', actionTo: '/financial-reports' };
  return {};
}

function normalizeItem(raw, source) {
  const level = normalizeLevel(raw.level || raw.severity || raw.type);
  const title = raw.title || raw.message || raw.insight || 'Heads up';
  // Keep a body only when it adds info beyond the title (avoid echoing the title).
  const message = raw.message && raw.message !== title ? raw.message : (raw.detail || '');
  const base = { id: raw.id || `${source}_${title}`.toLowerCase().replace(/\s+/g, '_'), source, level, title, message };
  return { ...base, ...actionFor(base) };
}

/** De-duplicate by normalised title (keep the most severe), then rank. */
function dedupeAndRank(items) {
  const byTitle = new Map();
  for (const it of items) {
    const key = String(it.title || '').trim().toLowerCase();
    const existing = byTitle.get(key);
    if (!existing || RANK[it.level] < RANK[existing.level]) byTitle.set(key, it);
  }
  return [...byTitle.values()].sort((a, b) => {
    const d = (RANK[a.level] ?? 3) - (RANK[b.level] ?? 3);
    return d !== 0 ? d : 0;
  });
}

/**
 * Recently AI-auto-posted entries (Phase 3) are surfaced as a passive,
 * low-urgency review item — never blocking, since the entries already posted
 * and are fully reversible. Returns null when there's nothing to show.
 */
function buildAutoPostedItem(count) {
  if (!count) return null;
  return {
    id: 'ai_auto_posted',
    source: 'ai',
    level: 'info',
    title: 'Transactions auto-posted by AI',
    message: `${count} transaction${count === 1 ? '' : 's'} were recorded automatically by AI in the last 24 hours — worth a quick spot-check.`,
    action: 'Review',
    actionTo: '/transactions?filter=ai_auto_posted',
  };
}

function countBy(items) {
  return {
    critical: items.filter((i) => i.level === 'critical').length,
    warning:  items.filter((i) => i.level === 'warning').length,
    info:     items.filter((i) => i.level === 'info').length,
    total:    items.length,
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   ORCHESTRATOR
════════════════════════════════════════════════════════════════════════════ */

async function getNeedsAttention(businessId) {
  if (!businessId) { const e = new Error('Business ID is required'); e.statusCode = 400; throw e; }
  const lstm = require('./forecasting/lstmForecastService'); // lazy — avoid cycle

  const trendMonitor = require('./trendMonitor.service'); // lazy — avoid cycle

  const JournalEntry = require('../models/JournalEntry.model'); // lazy — avoid cycle
  const { TRANSACTION_SOURCES } = require('../config/constants');
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [insightsRes, outlook, anomaly, persistedAlerts, autoPostedCount] = await Promise.allSettled([
    financialIntelligence.getFinancialInsights(businessId),
    businessHealth.getForwardOutlook(businessId, { horizonMonths: 6 }),
    lstm.fetchAnomalyRisk(businessId),
    trendMonitor.listOpen(businessId),
    JournalEntry.countDocuments({ businessId, transactionSource: TRANSACTION_SOURCES.AI_AUTO_POSTED, createdAt: { $gte: dayAgo } }),
  ]).then((r) => r.map((x) => (x.status === 'fulfilled' ? x.value : null)));

  const items = [];

  // FR-02.1/02.3 — persisted trend/invariant alerts (deduplicated, ack-able).
  for (const a of (persistedAlerts || [])) {
    items.push({
      id: `alert_${a.ruleKey}_${a.periodKey}`,
      source: 'trend-monitor',
      level: normalizeLevel(a.level),
      title: a.title,
      message: [a.what, a.howMuch, a.sinceWhen, a.recommendation].filter(Boolean).join(' '),
      action: 'Open', actionTo: a.actionTo || '/financial-reports',
      alertId: String(a._id),
    });
  }

  for (const s of (insightsRes?.insights || [])) items.push(normalizeItem(s, 'finance'));

  if (outlook && !outlook.insufficient) {
    for (const s of (outlook.signals || [])) {
      // "stable outlook" is reassurance, not an action item — skip it here.
      if (s.id === 'stable_outlook') continue;
      items.push(normalizeItem(s, 'forecast'));
    }
  }

  if (anomaly && (anomaly.total || 0) > 0 && (anomaly.riskScore || 0) >= 0.3) {
    items.push(normalizeItem({
      id: 'anomaly_alerts',
      level: (anomaly.riskScore || 0) >= 0.6 ? 'critical' : 'warning',
      title: 'Unusual transactions detected',
      message: `${anomaly.total} transaction${anomaly.total === 1 ? '' : 's'} look unusual and may be worth a closer look.`,
    }, 'anomaly'));
  }

  const autoPostedItem = buildAutoPostedItem(autoPostedCount);
  if (autoPostedItem) items.push(autoPostedItem);

  const merged = dedupeAndRank(items);
  return {
    items: merged,
    counts: countBy(merged),
    allClear: merged.length === 0,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  getNeedsAttention,
  _pure: { normalizeLevel, actionFor, normalizeItem, dedupeAndRank, countBy, buildAutoPostedItem },
};

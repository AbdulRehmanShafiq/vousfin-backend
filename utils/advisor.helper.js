// utils/advisor.helper.js — pure recommendation building for the Proactive AI
// CFO (Intelligence Roadmap Phase 4).
//
// Takes structured signals the service gathered from the tenant's REAL engines
// (13-week cash forecast, AR aging, health score, STP scorecard) and emits
// ranked, plain-language, executable recommendations. Grounded by construction:
// every "why" cites only numbers passed in — this helper cannot invent a fact.
// Framing stays "here's what your numbers say" — VousFin is not a licensed
// advisor and never tells anyone what to invest in.
'use strict';

const fmt = (n) => `Rs ${Math.round(Math.abs(Number(n) || 0)).toLocaleString('en-PK')}`;
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, info: 3 };

/**
 * @param {{
 *   liquidityAlerts?: Array<{weekStart:string, projectedClosing:number}>,
 *   receivableAging?: {over60Total:number, over60Count:number},
 *   healthScore?: {score:number},
 *   stp?: {stpScore:number|null},
 * }} signals
 * @returns {Array<{id, severity, title, why, action:{label,link}}>}
 */
function buildRecommendations(signals = {}) {
  const recs = [];

  // 1. Liquidity — the forecast projects a cash dip (critical; cash is oxygen).
  const alert = (signals.liquidityAlerts || [])[0];
  if (alert) {
    const week = alert.weekStart ? new Date(alert.weekStart).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : 'an upcoming week';
    recs.push({
      id: 'cash_low_week',
      severity: 'critical',
      title: 'Cash is projected to run low',
      why: `Your 13-week forecast projects cash of ${fmt(alert.projectedClosing)}${alert.projectedClosing < 0 ? ' below zero' : ''} in the week of ${week}.`,
      action: { label: 'Open the cash forecast', link: '/cash-flow' },
    });
  }

  // 2. Receivables — money owed to you for over 60 days (high; direct cash lever).
  const aging = signals.receivableAging || {};
  if ((aging.over60Total || 0) > 0) {
    recs.push({
      id: 'chase_overdue_receivables',
      severity: 'high',
      title: 'Chase long-overdue customer payments',
      why: `${fmt(aging.over60Total)} has been unpaid for more than 60 days across ${aging.over60Count || 0} invoice${(aging.over60Count || 0) === 1 ? '' : 's'}. Collecting it puts cash back in the business.`,
      action: { label: 'Review overdue invoices', link: '/receivables' },
    });
  }

  // 3. Health — the composite score is weak (medium; investigate the driver).
  const health = signals.healthScore;
  if (health && Number.isFinite(health.score) && health.score < 60) {
    recs.push({
      id: 'weak_health',
      severity: 'medium',
      title: 'Your business health score is low',
      why: `Your current health score is ${Math.round(health.score)} out of 100. The health page shows which measure is pulling it down.`,
      action: { label: 'See what needs attention', link: '/health' },
    });
  }

  // 4. Automation — plenty of manual work VousFin could be doing (info).
  const stp = signals.stp;
  if (stp && stp.stpScore !== null && stp.stpScore !== undefined && stp.stpScore < 0.5) {
    recs.push({
      id: 'raise_automation',
      severity: 'info',
      title: 'VousFin can take more work off your plate',
      why: `Right now VousFin handles ${Math.round(stp.stpScore * 100)}% of your bookkeeping work automatically. Turning on auto-record and auto-matching raises that safely.`,
      action: { label: 'Adjust automation settings', link: '/autonomy' },
    });
  }

  recs.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return recs;
}

module.exports = { buildRecommendations };

/**
 * Business Health Service — H1
 *
 * A real, auditable, server-side Business Health Score.
 *
 * Replaces the previous client-side heuristic (which hard-coded the tax score to
 * 82 and derived burn rate as `expenses / month-number`). Every sub-score here is
 * computed from the business's actual ledger via the existing report services, so
 * the result is reproducible and explainable:
 *
 *   • Liquidity     — current ratio + cash runway (real trailing burn)
 *   • Profitability — net margin + margin trend
 *   • Efficiency    — DSO (days sales outstanding) + overdue-AR ratio
 *   • Leverage      — debt-to-equity (solvency)
 *   • Tax           — real unremitted/overdue tax (only when tax is enabled)
 *
 * Honest gating: the overall score is a weighted average over ONLY the sub-scores
 * we can actually compute, and the whole result carries a data-sufficiency
 * confidence (insufficient / low / medium / high) driven by months of history.
 *
 * The scoring functions are PURE (numbers in → {score, drivers} out) so they are
 * unit-testable without a database. `getHealthScore` is the DB orchestrator.
 */
'use strict';

const mongoose = require('mongoose');
const reportService = require('./report.service');

/* ════════════════════════════════════════════════════════════════════════════
   PURE SCORING HELPERS  (no I/O — unit tested directly)
════════════════════════════════════════════════════════════════════════════ */

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const round = (v, d = 0) => {
  const p = 10 ** d;
  return Math.round((Number(v) || 0) * p) / p;
};

/** Map cash runway (months) to a 0–100 sub-component. */
function runwayPoints(runwayMonths) {
  if (!Number.isFinite(runwayMonths)) return null;
  if (runwayMonths >= 6) return 100;
  if (runwayMonths >= 3) return 80;
  if (runwayMonths >= 2) return 62;
  if (runwayMonths >= 1) return 42;
  return clamp(Math.round(runwayMonths * 36), 6, 42);
}

/** Map current ratio (current assets / current liabilities) to a 0–100 component. */
function currentRatioPoints(currentRatio) {
  if (!Number.isFinite(currentRatio)) return null;
  if (currentRatio >= 2) return 100;
  if (currentRatio >= 1.5) return 85;
  if (currentRatio >= 1) return 65;
  if (currentRatio >= 0.75) return 45;
  return clamp(Math.round(currentRatio * 50), 8, 45);
}

/**
 * Liquidity sub-score.
 * @param {{currentRatio?:number, runwayMonths?:number}} m
 */
function scoreLiquidity({ currentRatio, runwayMonths } = {}) {
  const parts = [];
  const drivers = [];

  const crP = currentRatioPoints(currentRatio);
  if (crP !== null) {
    parts.push(crP);
    drivers.push(
      currentRatio >= 1.5 ? `Current ratio ${round(currentRatio, 2)} — current assets comfortably cover short-term liabilities.`
      : currentRatio >= 1 ? `Current ratio ${round(currentRatio, 2)} — assets cover liabilities but with little buffer.`
      : `Current ratio ${round(currentRatio, 2)} — short-term liabilities exceed current assets.`
    );
  }

  const rwP = runwayPoints(runwayMonths);
  if (rwP !== null) {
    parts.push(rwP);
    const rw = runwayMonths >= 99 ? '6+' : round(runwayMonths, 1);
    drivers.push(
      runwayMonths >= 3 ? `Cash runway ~${rw} months — healthy buffer at the current burn rate.`
      : runwayMonths >= 1 ? `Cash runway ~${rw} months — monitor cash closely.`
      : `Cash runway under 1 month — immediate cash attention required.`
    );
  }

  if (parts.length === 0) return null;
  const score = clamp(Math.round(parts.reduce((a, b) => a + b, 0) / parts.length));
  return { score, level: levelOf(score), drivers };
}

/**
 * Profitability sub-score from net margin (%) and recent trend (% pts/month).
 * @param {{netMarginPct?:number, marginTrendPct?:number}} m
 */
function scoreProfitability({ netMarginPct, marginTrendPct } = {}) {
  if (!Number.isFinite(netMarginPct)) return null;
  let base =
    netMarginPct >= 25 ? 95 :
    netMarginPct >= 15 ? 82 :
    netMarginPct >= 8  ? 68 :
    netMarginPct >= 3  ? 58 :
    netMarginPct >= 0  ? 50 :
    clamp(Math.round(50 + netMarginPct * 1.5), 8, 50);

  const drivers = [
    netMarginPct >= 0
      ? `Net profit margin ${round(netMarginPct, 1)}%.`
      : `Operating at a loss (net margin ${round(netMarginPct, 1)}%).`,
  ];

  if (Number.isFinite(marginTrendPct) && Math.abs(marginTrendPct) >= 0.5) {
    const adj = clamp(marginTrendPct * 1.5, -8, 8);
    base = clamp(base + adj);
    drivers.push(
      marginTrendPct > 0
        ? `Margin improving (+${round(marginTrendPct, 1)} pts/mo recently).`
        : `Margin declining (${round(marginTrendPct, 1)} pts/mo recently).`
    );
  }

  const score = clamp(Math.round(base));
  return { score, level: levelOf(score), drivers };
}

/**
 * Efficiency sub-score from DSO (days) and overdue-AR ratio (0–1).
 * @param {{dso?:number, overdueRatio?:number}} m
 */
function scoreEfficiency({ dso, overdueRatio } = {}) {
  const drivers = [];
  let base = null;

  if (Number.isFinite(dso)) {
    base =
      dso <= 30 ? 92 :
      dso <= 45 ? 80 :
      dso <= 60 ? 66 :
      dso <= 90 ? 50 : 35;
    drivers.push(`Customers take ~${Math.round(dso)} days to pay (DSO).`);
  }

  if (Number.isFinite(overdueRatio)) {
    const penalty = clamp(Math.round(overdueRatio * 40), 0, 40);
    base = base === null ? clamp(85 - penalty) : clamp(base - penalty * 0.5);
    if (overdueRatio > 0.01) {
      drivers.push(`${round(overdueRatio * 100, 0)}% of receivables are overdue.`);
    } else {
      drivers.push('No material overdue receivables.');
    }
  }

  if (base === null) return null;
  const score = clamp(Math.round(base));
  return { score, level: levelOf(score), drivers };
}

/**
 * Leverage / solvency sub-score from debt-to-equity.
 * @param {{debtToEquity?:number, equityPositive?:boolean}} m
 */
function scoreLeverage({ debtToEquity, equityPositive = true } = {}) {
  if (equityPositive === false) {
    return { score: 20, level: 'poor', drivers: ['Negative equity — liabilities exceed assets (technically insolvent).'] };
  }
  if (!Number.isFinite(debtToEquity)) return null;
  const score =
    debtToEquity <= 0.5 ? 92 :
    debtToEquity <= 1   ? 80 :
    debtToEquity <= 2   ? 64 :
    debtToEquity <= 3   ? 48 : 30;
  const drivers = [
    debtToEquity <= 1
      ? `Debt-to-equity ${round(debtToEquity, 2)} — conservative leverage.`
      : `Debt-to-equity ${round(debtToEquity, 2)} — elevated leverage; debt is high relative to equity.`,
  ];
  return { score, level: levelOf(score), drivers };
}

/**
 * Tax-compliance sub-score. Returns null when tax is not enabled (excluded from
 * the overall score rather than faked).
 * @param {{enabled?:boolean, overdueTax?:number, accruingTax?:number}} m
 */
function scoreTax({ enabled, overdueTax = 0, accruingTax = 0 } = {}) {
  if (!enabled) return null;
  if (overdueTax > 0) {
    const score = clamp(60 - Math.min(40, Math.round(overdueTax > 0 ? 25 : 0)));
    return { score, level: levelOf(score), drivers: [`Overdue/unremitted tax outstanding (${round(overdueTax, 0)}).`] };
  }
  if (accruingTax > 0) {
    return { score: 80, level: 'good', drivers: ['Tax is accruing and current — remit before the filing deadline.'] };
  }
  return { score: 90, level: 'excellent', drivers: ['No overdue tax detected.'] };
}

function levelOf(score) {
  return score >= 80 ? 'excellent' : score >= 65 ? 'good' : score >= 50 ? 'fair' : 'poor';
}

/* Weights for the overall blend (renormalised over whatever is available). */
const WEIGHTS = { liquidity: 0.30, profitability: 0.25, efficiency: 0.20, leverage: 0.15, tax: 0.10 };

/**
 * Combine the available sub-scores into one overall 0–100 score, renormalising
 * weights over only the categories that were actually computed (honest gating).
 * @param {Record<string, {score:number}|null>} subScores
 */
function combineOverall(subScores) {
  let wSum = 0;
  let acc = 0;
  for (const [key, sub] of Object.entries(subScores)) {
    if (!sub || !Number.isFinite(sub.score)) continue;
    const w = WEIGHTS[key] || 0;
    acc += sub.score * w;
    wSum += w;
  }
  if (wSum === 0) return null;
  return clamp(Math.round(acc / wSum));
}

/* ════════════════════════════════════════════════════════════════════════════
   DB ORCHESTRATOR
════════════════════════════════════════════════════════════════════════════ */

const sumGroups = (groups, predicate) =>
  (groups || []).filter(predicate).reduce((s, g) => s + Math.abs(g.total || 0), 0);

/**
 * Compute the full Business Health Score for a business.
 * @param {string} businessId
 * @param {{asOfDate?:Date}} [opts]
 */
async function getHealthScore(businessId, opts = {}) {
  if (!businessId) {
    const err = new Error('Business ID is required');
    err.statusCode = 400;
    throw err;
  }
  const lstm = require('./forecasting/lstmForecastService'); // lazy — avoid cycle

  const asOf = opts.asOfDate ? new Date(opts.asOfDate) : new Date();
  const periodStart = new Date(asOf);
  periodStart.setMonth(periodStart.getMonth() - 12);

  const [balanceSheet, kpis, arAging, monthly] = await Promise.allSettled([
    reportService.getBalanceSheet(businessId, asOf),
    reportService.getKPISummary(businessId, periodStart, asOf),
    reportService.getAgingReport(businessId, 'receivable'),
    lstm.fetchMonthlyData(businessId, 12),
  ]).then((r) => r.map((x) => (x.status === 'fulfilled' ? x.value : null)));

  const months = Array.isArray(monthly) ? monthly : [];
  const nonZeroMonths = months.filter((m) => (m.revenue || 0) > 0 || (m.expenses || 0) > 0).length;

  // ── Data sufficiency / confidence ────────────────────────────────────────
  const hasBalanceSheet = !!balanceSheet && (balanceSheet.totalAssets || 0) > 0;
  if (nonZeroMonths === 0 && !hasBalanceSheet) {
    return {
      insufficient: true,
      confidence: 'insufficient',
      message: 'Not enough financial activity yet to score business health. Record a few transactions to unlock this.',
      asOfDate: asOf.toISOString(),
      generatedAt: new Date().toISOString(),
    };
  }
  const confidence =
    nonZeroMonths >= 6 ? 'high' :
    nonZeroMonths >= 3 ? 'medium' :
    'low';

  // ── Liquidity inputs ─────────────────────────────────────────────────────
  let currentRatio;
  let runwayMonths;
  if (balanceSheet) {
    const assetGroups = balanceSheet.assets?.groups || [];
    const liabGroups = balanceSheet.liabilities?.groups || [];
    const currentAssets = sumGroups(assetGroups, (g) =>
      ['Current Assets', 'Bank and Cash'].includes(g.label));
    const currentLiabilities = sumGroups(liabGroups, (g) => g.label === 'Current Liabilities');
    if (currentLiabilities > 0) currentRatio = currentAssets / currentLiabilities;
  }
  // Real burn = trailing-3-month average expense (NOT expenses / month-number).
  const recent = months.slice(-3);
  const avgBurn = recent.length
    ? recent.reduce((s, m) => s + (m.expenses || 0), 0) / recent.length
    : 0;
  const cashBalance = kpis?.cashBalance ?? 0;
  if (avgBurn > 0) runwayMonths = cashBalance / avgBurn;
  else if (cashBalance > 0) runwayMonths = 99; // cash but no burn

  // ── Profitability inputs ─────────────────────────────────────────────────
  const netMarginPct = Number.isFinite(kpis?.profitMargin) ? kpis.profitMargin : undefined;
  const marginTrendPct = marginTrend(months);

  // ── Efficiency inputs ────────────────────────────────────────────────────
  let dso;
  let overdueRatio;
  if (arAging && typeof arAging.grandTotal === 'number' && arAging.grandTotal > 0) {
    overdueRatio = (arAging.overdueTotal || 0) / arAging.grandTotal;
    // DSO ≈ outstanding AR / avg daily revenue (trailing 3 months)
    const avgMonthlyRev = recent.length
      ? recent.reduce((s, m) => s + (m.revenue || 0), 0) / recent.length
      : 0;
    if (avgMonthlyRev > 0) dso = (arAging.grandTotal / avgMonthlyRev) * 30;
  } else if (arAging) {
    overdueRatio = 0; // AR exists path but nothing outstanding → clean
  }

  // ── Leverage inputs ──────────────────────────────────────────────────────
  let debtToEquity;
  let equityPositive = true;
  if (balanceSheet) {
    const totalLiab = Math.abs(balanceSheet.totalLiabilities || 0);
    const totalEquity = balanceSheet.totalEquity || 0;
    equityPositive = totalEquity > 0;
    if (totalEquity > 0) debtToEquity = totalLiab / totalEquity;
  }

  // ── Tax inputs (real, gated) ─────────────────────────────────────────────
  const taxInputs = await taxComplianceInputs(businessId, periodStart, asOf);

  // ── Score ────────────────────────────────────────────────────────────────
  const subScores = {
    liquidity:     scoreLiquidity({ currentRatio, runwayMonths }),
    profitability: scoreProfitability({ netMarginPct, marginTrendPct }),
    efficiency:    scoreEfficiency({ dso, overdueRatio }),
    leverage:      scoreLeverage({ debtToEquity, equityPositive }),
    tax:           scoreTax(taxInputs),
  };
  const overall = combineOverall(subScores);

  const result = {
    insufficient: false,
    overall,
    level: overall != null ? levelOf(overall) : null,
    confidence,
    monthsOfData: nonZeroMonths,
    categories: subScores,
    metrics: {
      currentRatio: round(currentRatio, 2),
      runwayMonths: runwayMonths >= 99 ? null : round(runwayMonths, 1),
      netMarginPct: round(netMarginPct, 1),
      marginTrendPct: round(marginTrendPct, 2),
      dso: dso != null ? Math.round(dso) : null,
      overdueArPct: overdueRatio != null ? round(overdueRatio * 100, 0) : null,
      debtToEquity: round(debtToEquity, 2),
      monthlyBurn: round(avgBurn, 0),
      cashBalance: round(cashBalance, 0),
    },
    asOfDate: asOf.toISOString(),
    generatedAt: new Date().toISOString(),
  };

  // H5 — record today's snapshot so the score is trendable/auditable over time.
  // Fire-and-forget + DB-readyState-guarded: it never affects this response.
  _persistSnapshot(businessId, result);
  return result;
}

/* ════════════════════════════════════════════════════════════════════════════
   HISTORY / TREND  (H5)
════════════════════════════════════════════════════════════════════════════ */

const _toObjId = (id) =>
  (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id);

/** Upsert today's health snapshot. Never throws; skips if the DB isn't ready. */
function _persistSnapshot(businessId, result) {
  try {
    if (!result || result.insufficient || result.overall == null) return;
    if (mongoose.connection.readyState !== 1) return; // DB not connected → skip
    const HealthSnapshot = require('../models/HealthSnapshot.model');
    const date = String(result.asOfDate || new Date().toISOString()).slice(0, 10);
    const cats = result.categories || {};
    const catScore = (k) => (cats[k] && Number.isFinite(cats[k].score) ? cats[k].score : null);
    HealthSnapshot.updateOne(
      { businessId: _toObjId(businessId), date },
      {
        $set: {
          businessId: _toObjId(businessId), date,
          overall: result.overall,
          confidence: result.confidence || null,
          categories: {
            liquidity: catScore('liquidity'), profitability: catScore('profitability'),
            efficiency: catScore('efficiency'), leverage: catScore('leverage'), tax: catScore('tax'),
          },
          metrics: result.metrics || {},
          capturedAt: new Date(),
        },
      },
      { upsert: true }
    ).catch(() => { /* snapshot is best-effort */ });
  } catch (_e) { /* never throw from persistence */ }
}

/**
 * Health score over time + the change vs ~30 days ago, for the trend sparkline.
 * @param {string} businessId
 * @param {number} [days=90]
 */
async function getHealthHistory(businessId, days = 90) {
  if (!businessId) { const e = new Error('Business ID is required'); e.statusCode = 400; throw e; }
  const HealthSnapshot = require('../models/HealthSnapshot.model');
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Math.max(7, Math.min(365, days)));
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const rows = await HealthSnapshot.find(
    { businessId: _toObjId(businessId), date: { $gte: cutoffStr } },
    { date: 1, overall: 1, _id: 0 }
  ).sort({ date: 1 }).lean();

  const points = rows.map((r) => ({ date: r.date, overall: r.overall }));

  // Δ vs the latest snapshot on/before ~30 days ago (else the earliest we have).
  let delta = null;
  if (points.length >= 2) {
    const current = points[points.length - 1];
    const target = new Date(); target.setDate(target.getDate() - 30);
    const targetStr = target.toISOString().slice(0, 10);
    const prior = [...points].reverse().find((p) => p.date <= targetStr) || points[0];
    if (prior && prior.date !== current.date) {
      delta = { value: current.overall - prior.overall, fromDate: prior.date };
    }
  }

  return {
    points,
    delta,
    current: points.length ? points[points.length - 1].overall : null,
    generatedAt: new Date().toISOString(),
  };
}

/** Recent margin trend in percentage-points per month (simple slope over last 4). */
function marginTrend(months) {
  const pts = (months || [])
    .filter((m) => (m.revenue || 0) > 0)
    .slice(-4)
    .map((m) => ((m.revenue - m.expenses) / m.revenue) * 100);
  if (pts.length < 2) return undefined;
  // average consecutive delta
  let sum = 0;
  for (let i = 1; i < pts.length; i++) sum += pts[i] - pts[i - 1];
  return sum / (pts.length - 1);
}

/**
 * Pull real tax-compliance signals. Returns { enabled:false } when tax isn't on,
 * so the tax sub-score is cleanly excluded instead of faked.
 */
async function taxComplianceInputs(businessId, startDate, endDate) {
  try {
    const summary = await reportService.getTaxSummary(businessId, startDate, endDate);
    if (!summary) return { enabled: false };
    const taxActivity = (Number(summary.totalOutputTax) || 0) + (Number(summary.totalInputTax) || 0);
    if (taxActivity <= 0) return { enabled: false }; // business doesn't record tax → exclude
    // getTaxSummary carries no due-date, so we CANNOT label anything "overdue".
    // A positive net liability is tax currently accruing (payable), not overdue.
    const netPayable = Math.max(0, Number(summary.netTaxLiability) || 0);
    return { enabled: true, overdueTax: 0, accruingTax: netPayable };
  } catch (_e) {
    return { enabled: false };
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   FORWARD-LOOKING OUTLOOK  (H3) — projects health using the ensemble forecast
════════════════════════════════════════════════════════════════════════════ */

/** Months until projected cash depletes, walking the net-cash trajectory.
 *  Returns null if cash survives the whole horizon; 0 if already non-positive. */
function projectRunway(startCash, netSeries) {
  if (!(startCash > 0)) return 0;
  let cash = startCash;
  for (let i = 0; i < (netSeries || []).length; i++) {
    const prev = cash;
    cash += netSeries[i] || 0;
    if (cash <= 0) {
      const drop = prev - cash; // > 0
      const frac = drop > 0 ? prev / drop : 0;
      return round(i + clamp(frac, 0, 1), 1);
    }
  }
  return null;
}

/** Projected net margin (%) over the horizon from forecast revenue/expense. */
function projectedMarginPct(revSeries, expSeries) {
  const rev = (revSeries || []).reduce((s, v) => s + (v || 0), 0);
  const exp = (expSeries || []).reduce((s, v) => s + (v || 0), 0);
  return rev > 0 ? ((rev - exp) / rev) * 100 : null;
}

/** Confidence from relative interval width (narrower band → more confident). */
function bandConfidence(predicted, lower, upper) {
  const ratios = [];
  for (let i = 0; i < (predicted || []).length; i++) {
    const p = Math.abs(predicted[i]);
    if (p > 0 && Number.isFinite(lower?.[i]) && Number.isFinite(upper?.[i])) {
      ratios.push(((upper[i] - lower[i]) / 2) / p);
    }
  }
  if (!ratios.length) return 'low';
  const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return avg < 0.15 ? 'high' : avg < 0.35 ? 'medium' : 'low';
}

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1, insufficient: 0 };
const weakerConfidence = (a, b) =>
  ((CONFIDENCE_RANK[a] ?? 0) <= (CONFIDENCE_RANK[b] ?? 0) ? a : b);

function monthLabels(from, n) {
  const out = [];
  const d = new Date(from);
  for (let i = 1; i <= n; i++) {
    out.push(new Date(d.getFullYear(), d.getMonth() + i, 1).toLocaleString('en', { month: 'short' }));
  }
  return out;
}

/**
 * Forward-looking outlook: project runway, future margin, a forward health
 * score and proactive signals from the ensemble forecast (read-only — uses the
 * pure computeFromSeries so it never writes forecast records).
 * @param {string} businessId
 * @param {{horizonMonths?:number}} [opts]
 */
async function getForwardOutlook(businessId, opts = {}) {
  if (!businessId) { const e = new Error('Business ID is required'); e.statusCode = 400; throw e; }
  const ensembleForecast = require('./forecasting/ensembleForecast.service');
  const lstm = require('./forecasting/lstmForecastService');

  const horizon = Math.max(1, Math.min(12, opts.horizonMonths || 6));
  const asOf = new Date();
  const periodStart = new Date(asOf); periodStart.setMonth(periodStart.getMonth() - 12);

  const [monthly, kpis] = await Promise.allSettled([
    lstm.fetchMonthlyData(businessId, 24),
    reportService.getKPISummary(businessId, periodStart, asOf),
  ]).then((r) => r.map((x) => (x.status === 'fulfilled' ? x.value : null)));

  const months = Array.isArray(monthly) ? monthly : [];
  const revSeries = months.map((m) => m.revenue || 0);
  const expSeries = months.map((m) => m.expenses || 0);
  const nonZero = months.filter((m) => (m.revenue || 0) > 0 || (m.expenses || 0) > 0).length;
  const period = revSeries.filter((v) => v > 0).length >= 6 ? 3 : 2;

  const revFc = ensembleForecast.computeFromSeries(revSeries, { horizon, period, alpha: 0.1 });
  const expFc = ensembleForecast.computeFromSeries(expSeries, { horizon, period, alpha: 0.1 });

  if (!revFc || !expFc) {
    return {
      insufficient: true,
      message: 'Not enough history to project a reliable outlook yet. About 4+ months of revenue and expense data unlocks this.',
      horizonMonths: horizon, asOfDate: asOf.toISOString(), generatedAt: new Date().toISOString(),
    };
  }

  const net = revFc.predicted.map((r, i) => r - (expFc.predicted[i] || 0));
  const worst = revFc.predicted.map((_, i) => (revFc.lower[i] || 0) - (expFc.upper[i] || 0));
  const best = revFc.predicted.map((_, i) => (revFc.upper[i] || 0) - (expFc.lower[i] || 0));

  const cash = kpis?.cashBalance ?? 0;
  const runway = projectRunway(cash, net);
  const runwayPessimistic = projectRunway(cash, worst);
  const runwayOptimistic = projectRunway(cash, best);

  const projMargin = projectedMarginPct(revFc.predicted, expFc.predicted);
  const currentMargin = Number.isFinite(kpis?.profitMargin) ? kpis.profitMargin : null;
  const marginDelta = (projMargin != null && currentMargin != null) ? projMargin - currentMargin : null;

  const fwdProfit = scoreProfitability({
    netMarginPct: projMargin,
    marginTrendPct: marginDelta != null ? marginDelta / horizon : undefined,
  });
  const fwdLiquidity = scoreLiquidity({ runwayMonths: runway == null ? 99 : runway });
  const fwdOverall = combineOverall({ profitability: fwdProfit, liquidity: fwdLiquidity });

  const confidence = weakerConfidence(
    bandConfidence(revFc.predicted, revFc.lower, revFc.upper),
    nonZero >= 6 ? 'high' : nonZero >= 3 ? 'medium' : 'low'
  );

  // ── Proactive signals ────────────────────────────────────────────────────
  const signals = [];
  if (runway != null && runway <= horizon) {
    signals.push({
      id: 'projected_cash_shortfall',
      level: runway <= 2 ? 'critical' : 'warning',
      title: 'Projected cash shortfall',
      message: `At the forecast burn rate, cash is projected to run low in ~${runway} month${runway === 1 ? '' : 's'}` +
        (runwayPessimistic != null && runwayPessimistic < runway ? ` (as soon as ~${runwayPessimistic} in a downside scenario).` : '.'),
    });
  }
  const lastRev = revSeries.filter((v) => v > 0).slice(-1)[0] || 0;
  const avgFcRev = revFc.predicted.reduce((a, b) => a + b, 0) / revFc.predicted.length;
  if (lastRev > 0 && avgFcRev < lastRev * 0.9) {
    signals.push({
      id: 'revenue_decline', level: 'warning', title: 'Revenue projected to decline',
      message: `Forecast revenue averages ${Math.round((1 - avgFcRev / lastRev) * 100)}% below your latest month.`,
    });
  }
  if (marginDelta != null && marginDelta < -1) {
    signals.push({
      id: 'margin_compression', level: 'info', title: 'Margin compression ahead',
      message: `Projected net margin ${round(projMargin, 1)}% vs current ${round(currentMargin, 1)}%.`,
    });
  }
  if (signals.length === 0 && runway == null) {
    signals.push({
      id: 'stable_outlook', level: 'info', title: 'Stable outlook',
      message: `Cash is projected to stay positive across the next ${horizon} months at the forecast burn rate.`,
    });
  }

  return {
    insufficient: false,
    horizonMonths: horizon,
    labels: monthLabels(asOf, horizon),
    projected: {
      revenue: revFc.predicted, revenueLower: revFc.lower, revenueUpper: revFc.upper,
      expenses: expFc.predicted, expensesLower: expFc.lower, expensesUpper: expFc.upper,
      netCashFlow: net,
    },
    runway: {
      months: runway, pessimistic: runwayPessimistic, optimistic: runwayOptimistic,
      survivesHorizon: runway == null,
    },
    margin: {
      projectedPct: projMargin != null ? round(projMargin, 1) : null,
      currentPct: currentMargin != null ? round(currentMargin, 1) : null,
      deltaPct: marginDelta != null ? round(marginDelta, 1) : null,
    },
    forwardHealth: { overall: fwdOverall, level: fwdOverall != null ? levelOf(fwdOverall) : null },
    confidence,
    modelType: revFc.modelType,
    signals,
    asOfDate: asOf.toISOString(),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  getHealthScore,
  getForwardOutlook,
  getHealthHistory,
  // pure helpers exported for unit tests
  _pure: {
    scoreLiquidity, scoreProfitability, scoreEfficiency, scoreLeverage, scoreTax,
    combineOverall, runwayPoints, currentRatioPoints, levelOf, marginTrend,
    projectRunway, projectedMarginPct, bandConfidence, weakerConfidence,
  },
};

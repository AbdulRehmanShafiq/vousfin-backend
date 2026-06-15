/**
 * taxAdvisor.service.js — FR-04.2 (Intelligent Legal Tax Optimization Advisor)
 *
 * A read-only service: it builds a context from the live ledger (income
 * statement, GST reconciliation, fixed-asset & tax-receivable balances, WHT),
 * runs the deterministic rule catalog over it, and returns auditable advisories
 * — each citing a legal provision and a PKR saving. No writes, no hot path.
 */
'use strict';

const mongoose    = require('mongoose');
const report      = require('./report.service');
const taxReport   = require('./taxReport.service');
const accountRepo = require('../repositories/account.repository');
const { fiscalYearStart } = require('../utils/fiscalYearStart');
const { TAX_OPTIMIZATION_RULES } = require('../config/taxOptimizationRules');

const Business = () => mongoose.model('Business');
const num = (v) => Number(v) || 0;
const r0  = (v) => Math.round(num(v));
const sum = (arr) => arr.reduce((s, v) => s + num(v), 0);

const REVIEW_WARNING =
  'This is an estimate based on your current figures and projections — confirm the specifics with a tax professional before acting.';

/** The month containing `asOf` — the current GST filing window. */
function currentMonthRange(asOf) {
  return {
    startDate: new Date(asOf.getFullYear(), asOf.getMonth(), 1),
    endDate:   new Date(asOf.getFullYear(), asOf.getMonth() + 1, 0, 23, 59, 59, 999),
  };
}

const isAccumulated = (a) => /accumulated/i.test(a.accountName || '');
const isFixedAsset  = (a) => a.accountSubtype === 'Non-current Assets' && a.normalBalance === 'Debit' && !isAccumulated(a);
const isAdvanceTax  = (a) =>
  /^117[0-7]$/.test(a.accountCode || '') ||
  /advance tax|income tax receivable|wht receivable|withholding.*receivable|tax credit/i.test(a.accountName || '');

/**
 * Assemble the optimisation context for a business from live sources.
 * @param {string} businessId
 * @param {Date}   [asOf]
 */
async function buildContext(businessId, asOf = new Date()) {
  const biz      = await Business().findById(businessId).select('taxConfig currency fiscalYearStartMonth').lean();
  const cfg      = (biz && biz.taxConfig) || {};
  const country  = cfg.country || 'PK';
  const currency = (biz && biz.currency) || 'PKR';
  const rawRate  = Number(cfg.incomeTaxProvisionRate);
  const provisionRate = Number.isFinite(rawRate) ? rawRate : 0.29;
  const fyStart  = fiscalYearStart(asOf, biz && biz.fiscalYearStartMonth);

  const [incomeStmt, gst, assets, wht] = await Promise.all([
    report.getIncomeStatement(businessId, fyStart, asOf).catch(() => null),
    taxReport.reconcileTaxToLedger(businessId, currentMonthRange(asOf), country).catch(() => ({})),
    accountRepo.findByBusiness(businessId, 'Asset').catch(() => []),
    taxReport.getWhtSummary(businessId, { startDate: fyStart, endDate: asOf }).catch(() => ({})),
  ]);

  const list = Array.isArray(assets) ? assets : [];
  const netProfitYTD = num(incomeStmt && (incomeStmt.netProfit ?? incomeStmt.netIncome));
  const revenueYTD   = num(incomeStmt && incomeStmt.totalRevenue);
  const depreciationBookedYTD = num(incomeStmt && incomeStmt.depreciationAmortization && incomeStmt.depreciationAmortization.total);

  // Whole months from FY start through the as-of month (inclusive).
  const monthsElapsed = Math.max(
    1,
    (asOf.getFullYear() - fyStart.getFullYear()) * 12 + (asOf.getMonth() - fyStart.getMonth()) + 1,
  );
  const projectedAnnualIncome = r0((netProfitYTD / monthsElapsed) * 12);

  return {
    businessId, currency, country, provisionRate,
    netProfitYTD, revenueYTD, depreciationBookedYTD,
    monthsElapsed, projectedAnnualIncome,
    // ChartOfAccount stores the signed running balance in `runningBalance`
    // (positive when in its normal-balance position).
    fixedAssetsGross:        sum(list.filter(isFixedAsset).map(a => a.runningBalance)),
    accumulatedDepreciation: sum(list.filter(isAccumulated).map(a => Math.abs(num(a.runningBalance)))),
    advanceTaxPaid:          sum(list.filter(isAdvanceTax).map(a => Math.abs(num(a.runningBalance)))),
    glNetPayable: num(gst && gst.glNetPayable),
    glInputTax:   num(gst && gst.glInputTax),
    glOutputTax:  num(gst && gst.glOutputTax),
    whtWithheldYTD: num(wht && wht.totalWht),
  };
}

/**
 * Run the rule catalog over the live context and return ranked advisories.
 * @returns {Promise<{currency:string, totalPotentialSavingPKR:number, advisories:object[]}>}
 */
async function getAdvisories(businessId, asOf = new Date()) {
  const ctx = await buildContext(businessId, asOf);

  const advisories = [];
  for (const rule of TAX_OPTIMIZATION_RULES) {
    let hit = null;
    try { hit = rule.detect(ctx); } catch { hit = null; }
    if (!hit || !(hit.estimatedSavingPKR > 0)) continue;

    advisories.push({
      id:                 rule.id,
      taxType:            rule.taxType,
      title:              rule.title,
      legalRef:           rule.legalRef,
      riskLevel:          rule.riskLevel,
      estimatedSavingPKR: r0(hit.estimatedSavingPKR),
      explanation:        hit.explanation,
      actionLink:         hit.actionLink || '/tax',
      ...(rule.riskLevel === 'review' ? { riskWarning: REVIEW_WARNING } : {}),
    });
  }

  advisories.sort((a, b) => b.estimatedSavingPKR - a.estimatedSavingPKR);

  return {
    currency: ctx.currency,
    totalPotentialSavingPKR: r0(sum(advisories.map(a => a.estimatedSavingPKR))),
    advisories,
  };
}

module.exports = { buildContext, getAdvisories, currentMonthRange };

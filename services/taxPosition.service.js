/**
 * taxPosition.service.js — FR-04.1 (Continuous Real-Time Tax Liability Engine)
 *
 * A READ MODEL over the live GL — it does NOT write or recompute tax. It reads
 * the authoritative tax movement (taxReport.reconcileTaxToLedger) and WHT
 * collected for the current filing period, attaches the next filing deadline
 * per tax type, and returns one stable contract the dashboard + returns consume.
 *
 * Phase 1 tracks GST + WHT (already engine-computed). INCOME_TAX provision and
 * EOBI/SESSI are reported as `not_tracked` until Phase 3 supplies them.
 */
'use strict';

const mongoose  = require('mongoose');
const taxReport = require('./taxReport.service');
const report    = require('./report.service');
const payrollRepo = require('../repositories/payrollAccrual.repository');
const { getCalendar } = require('../config/taxFilingCalendar');
const { nextDeadline } = require('../utils/nextDeadline');
const { fiscalYearStart } = require('../utils/fiscalYearStart');

const Business = () => mongoose.model('Business');
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const DEFAULT_PROVISION_RATE = 0.29; // PK company income-tax rate

/** The month containing `asOf` — the next GST/WHT filing window. */
function currentMonthRange(asOf) {
  const startDate = new Date(asOf.getFullYear(), asOf.getMonth(), 1);
  const endDate   = new Date(asOf.getFullYear(), asOf.getMonth() + 1, 0, 23, 59, 59, 999);
  return { startDate, endDate };
}

/**
 * Current tax position across every applicable tax type.
 * @param {string} businessId
 * @param {Date}   [asOf]
 * @returns {Promise<{asOf:string, currency:string, country:string, taxes:object[], totalPayable:number}>}
 */
async function getLivePosition(businessId, asOf = new Date()) {
  const biz      = await Business().findById(businessId).select('taxConfig currency fiscalYearStartMonth').lean();
  const cfg      = (biz && biz.taxConfig) || {};
  const country  = cfg.country || 'PK';
  const currency = (biz && biz.currency) || 'PKR';
  const period   = currentMonthRange(asOf);
  const fyStart  = fiscalYearStart(asOf, biz && biz.fiscalYearStartMonth);

  const [gst, wht, incomeStmt] = await Promise.all([
    taxReport.reconcileTaxToLedger(businessId, period, country), // GL-authoritative output/input
    taxReport.getWhtSummary(businessId, period),                 // WHT collected this period
    // Net-profit YTD for the continuous income-tax provision. A failure here must
    // not break the rest of the position → fall back to null (income tax not_tracked).
    report.getIncomeStatement(businessId, fyStart, asOf).catch(() => null),
  ]);

  // Income-tax provision = rate × max(0, net-profit YTD).
  const rawRate       = Number(cfg.incomeTaxProvisionRate);
  const provisionRate = Number.isFinite(rawRate) ? rawRate : DEFAULT_PROVISION_RATE;
  const netProfitYTD  = Number(incomeStmt && (incomeStmt.netProfit ?? incomeStmt.netIncome)) || 0;
  const incomeTax     = incomeStmt ? r2(provisionRate * Math.max(0, netProfitYTD)) : 0;
  const incomeTaxStatus = incomeStmt ? 'tracked' : 'not_tracked';

  // Payroll obligations (EOBI/SESSI) — only queried/tracked when explicitly enabled,
  // read from the latest monthly accrual (Phase 3.3, minimal — no full payroll module).
  let eobi = 0, sessi = 0, payrollStatus = 'not_tracked';
  if (cfg.payrollEnabled) {
    const accrual = await payrollRepo.latest(businessId);
    eobi  = r2(accrual && accrual.eobi);
    sessi = r2(accrual && accrual.sessi);
    payrollStatus = 'tracked';
  }

  const calendar = getCalendar(country);
  const deadlineFor = (taxType) => {
    const rule = calendar.find(r => r.taxType === taxType);
    if (!rule) return null;
    const { dueDate, daysRemaining } = nextDeadline(rule, asOf);
    return { dueDate, daysRemaining, returnType: rule.returnType, label: rule.label };
  };

  const gstNet = r2(gst.glNetPayable);

  const taxes = [
    { taxType: 'GST',        label: 'GST / Sales Tax',       liability: Math.max(0, gstNet), refundable: gstNet < 0, raw: gstNet, nextDeadline: deadlineFor('GST'),        status: 'tracked'     },
    { taxType: 'WHT',        label: 'Withholding Tax',       liability: r2(wht.totalWht),    refundable: false,                  nextDeadline: deadlineFor('WHT'),        status: 'tracked'     },
    { taxType: 'INCOME_TAX', label: 'Income Tax (provision)', liability: incomeTax,           refundable: false,                  nextDeadline: deadlineFor('INCOME_TAX'), status: incomeTaxStatus },
    { taxType: 'EOBI',       label: 'EOBI',                  liability: eobi,                refundable: false,                  nextDeadline: deadlineFor('EOBI'),       status: payrollStatus },
    { taxType: 'SESSI',      label: 'SESSI',                 liability: sessi,               refundable: false,                  nextDeadline: deadlineFor('SESSI'),      status: payrollStatus },
  ];

  const totalPayable = r2(taxes.reduce((s, t) => s + (t.liability || 0), 0));

  return { asOf: asOf.toISOString(), currency, country, taxes, totalPayable };
}

module.exports = { getLivePosition, currentMonthRange };

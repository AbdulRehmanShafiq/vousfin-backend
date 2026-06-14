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
const { getCalendar } = require('../config/taxFilingCalendar');
const { nextDeadline } = require('../utils/nextDeadline');

const Business = () => mongoose.model('Business');
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

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
  const biz      = await Business().findById(businessId).select('taxConfig currency').lean();
  const cfg      = (biz && biz.taxConfig) || {};
  const country  = cfg.country || 'PK';
  const currency = (biz && biz.currency) || 'PKR';
  const period   = currentMonthRange(asOf);

  const [gst, wht] = await Promise.all([
    taxReport.reconcileTaxToLedger(businessId, period, country), // GL-authoritative output/input
    taxReport.getWhtSummary(businessId, period),                 // WHT collected this period
  ]);

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
    { taxType: 'INCOME_TAX', label: 'Income Tax (provision)', liability: 0,                  refundable: false,                  nextDeadline: deadlineFor('INCOME_TAX'), status: 'not_tracked' },
    { taxType: 'EOBI',       label: 'EOBI',                  liability: 0,                   refundable: false,                  nextDeadline: deadlineFor('EOBI'),       status: 'not_tracked' },
    { taxType: 'SESSI',      label: 'SESSI',                 liability: 0,                   refundable: false,                  nextDeadline: deadlineFor('SESSI'),      status: 'not_tracked' },
  ];

  const totalPayable = r2(taxes.reduce((s, t) => s + (t.liability || 0), 0));

  return { asOf: asOf.toISOString(), currency, country, taxes, totalPayable };
}

module.exports = { getLivePosition, currentMonthRange };

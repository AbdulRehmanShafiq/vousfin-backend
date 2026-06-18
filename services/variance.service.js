// services/variance.service.js — FR-04.2
'use strict';
const mongoose = require('mongoose');
const JournalEntry = require('../models/JournalEntry.model');
const { EFFECTIVE_LINES_STAGE, REPORT_STATUSES } = require('../repositories/transaction.repository');
const budgetRepo = require('../repositories/budget.repository');
const fyRepo = require('../repositories/fiscalYear.repository');
const accountRepo = require('../repositories/account.repository');
const FinancialAlert = require('../models/FinancialAlert.model');
const { ApiError } = require('../utils/ApiError');

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const key = (accountId, cc) => `${String(accountId)}|${cc ? String(cc) : ''}`;

function _matchStage(businessId, from, to) {
  return {
    $match: {
      businessId: oid(businessId),
      transactionDate: { $gte: new Date(from), $lte: new Date(to) },
      status: { $in: REPORT_STATUSES },
      isArchived: { $ne: true },
    },
  };
}

// Carry a per-line cost centre: prefer the journalLines cost centre, else the
// entry-level costCenterId (synthesised pairs have no per-line cost centre).
const ADD_LINE_CC = {
  $addFields: { 'effectiveLines.cc': { $ifNull: ['$effectiveLines.costCenterId', '$costCenterId'] } },
};

/** Debit/credit sums per account+cost-centre over [from,to]. */
async function actualsByLine(businessId, { from, to }) {
  const rows = await JournalEntry.aggregate([
    _matchStage(businessId, from, to),
    EFFECTIVE_LINES_STAGE,
    { $unwind: '$effectiveLines' },
    ADD_LINE_CC,
    {
      $group: {
        _id: { accountId: '$effectiveLines.accountId', cc: '$effectiveLines.cc' },
        debit:  { $sum: { $cond: [{ $eq: ['$effectiveLines.type', 'debit'] },  '$effectiveLines.amount', 0] } },
        credit: { $sum: { $cond: [{ $eq: ['$effectiveLines.type', 'credit'] }, '$effectiveLines.amount', 0] } },
      },
    },
  ]);
  const map = {};
  for (const r of rows) map[key(r._id.accountId, r._id.cc)] = { debit: r.debit, credit: r.credit };
  return map;
}

/** Per-account 12-month actuals for [from,to] — used to seed a budget from the
 *  prior year. Returns the absolute monthly net per account+cost-centre. */
async function actualsByMonth(businessId, { from, to }) {
  const start = new Date(from);
  const rows = await JournalEntry.aggregate([
    _matchStage(businessId, from, to),
    EFFECTIVE_LINES_STAGE,
    { $unwind: '$effectiveLines' },
    ADD_LINE_CC,
    {
      $addFields: {
        _monthIdx: {
          $add: [
            { $multiply: [{ $subtract: [{ $year: '$transactionDate' }, start.getUTCFullYear()] }, 12] },
            { $subtract: [{ $month: '$transactionDate' }, start.getUTCMonth() + 1] },
          ],
        },
        _signed: {
          $cond: [{ $eq: ['$effectiveLines.type', 'debit'] }, '$effectiveLines.amount', { $multiply: ['$effectiveLines.amount', -1] }],
        },
      },
    },
    {
      $group: {
        _id: { accountId: '$effectiveLines.accountId', cc: '$effectiveLines.cc', m: '$_monthIdx' },
        net: { $sum: '$_signed' },
      },
    },
  ]);
  const byAccount = {};
  for (const r of rows) {
    const k = key(r._id.accountId, r._id.cc);
    if (!byAccount[k]) byAccount[k] = { accountId: String(r._id.accountId), costCenterId: r._id.cc ? String(r._id.cc) : null, monthly: Array(12).fill(0) };
    const idx = r._id.m;
    if (idx >= 0 && idx < 12) byAccount[k].monthly[idx] += Math.abs(r.net);
  }
  return Object.values(byAccount);
}

/** Fiscal months elapsed from year start to asOf, clamped 1..12. */
function monthsElapsed(fyStart, asOf) {
  const s = new Date(fyStart), a = new Date(asOf);
  const m = (a.getUTCFullYear() - s.getUTCFullYear()) * 12 + (a.getUTCMonth() - s.getUTCMonth()) + 1;
  return Math.max(1, Math.min(12, m));
}

function ragFor(favorable, pct, thresholdPct) {
  if (favorable) return 'green';
  const t = (Number(thresholdPct) || 0) / 100;
  const abs = pct == null ? 0 : Math.abs(pct);
  if (abs <= t) return 'green';
  if (abs <= 2 * t) return 'amber';
  return 'red';
}

async function computeVariance(businessId, budgetId, { asOf } = {}) {
  const budget = await budgetRepo.findOwnedById(businessId, budgetId);
  if (!budget) throw new ApiError(404, 'Budget not found.');
  const fy = await fyRepo.findOwnedById(businessId, budget.fiscalYearId);
  if (!fy) throw new ApiError(404, 'Fiscal year not found.');

  const at = asOf ? new Date(asOf) : new Date();
  const windowEnd = at > new Date(fy.endDate) ? new Date(fy.endDate) : at;
  const elapsed = monthsElapsed(fy.startDate, windowEnd);

  const [actuals, accounts] = await Promise.all([
    this.actualsByLine(businessId, { from: fy.startDate, to: windowEnd }),
    accountRepo.findByBusiness(businessId),
  ]);
  const typeById = new Map((accounts || []).map((a) => [String(a._id), a.accountType]));
  const nameById = new Map((accounts || []).map((a) => [String(a._id), a.accountName]));

  const lines = (budget.lines || []).map((l) => {
    const dc = actuals[key(l.accountId, l.costCenterId)] || { debit: 0, credit: 0 };
    const type = typeById.get(String(l.accountId)) || 'Expense';
    const isRevenue = type === 'Revenue';
    const actual = round2(isRevenue ? dc.credit - dc.debit : dc.debit - dc.credit);
    const budgetAmt = round2((l.monthly || []).slice(0, elapsed).reduce((s, m) => s + (Number(m) || 0), 0));
    const v = round2(actual - budgetAmt);
    const variancePct = budgetAmt === 0 ? null : round2(v / Math.abs(budgetAmt));
    const favorable = isRevenue ? actual >= budgetAmt : actual <= budgetAmt;
    const threshold = l.thresholdPct != null ? l.thresholdPct : budget.defaultThresholdPct;
    return {
      accountId: String(l.accountId),
      accountName: nameById.get(String(l.accountId)) || '',
      accountType: type,
      costCenterId: l.costCenterId ? String(l.costCenterId) : null,
      budget: budgetAmt, actual, variance: v, variancePct, favorable,
      rag: ragFor(favorable, variancePct, threshold),
      drillFilter: { accountId: String(l.accountId), costCenterId: l.costCenterId ? String(l.costCenterId) : null,
                     from: fy.startDate, to: windowEnd },
    };
  });

  return {
    budgetId: String(budget._id), scenario: budget.scenario,
    fiscalYearId: String(budget.fiscalYearId), asOf: windowEnd, monthsElapsed: elapsed, lines,
    totals: {
      budget: round2(lines.reduce((s, l) => s + l.budget, 0)),
      actual: round2(lines.reduce((s, l) => s + l.actual, 0)),
      variance: round2(lines.reduce((s, l) => s + l.variance, 0)),
    },
  };
}

const RAG_LEVEL = { red: 'critical', amber: 'warning' };

function _periodKey(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Recompute affected lines of every active budget covering the entry date and
 *  upsert a deduped FinancialAlert for each breaching (red, default) line. */
async function checkBreaches(businessId, affectedAccountIds, { entryDate, alertOn = ['red'] } = {}) {
  const when = entryDate ? new Date(entryDate) : new Date();
  const fy = await fyRepo.findContaining(businessId, when);
  if (!fy) return;
  const budgets = await budgetRepo.findActiveByFiscalYear(businessId, fy._id);
  if (!budgets || budgets.length === 0) return;

  const affected = new Set((affectedAccountIds || []).map(String));
  const periodKey = _periodKey(when);

  for (const b of budgets) {
    const result = await this.computeVariance(businessId, b._id, { asOf: when });
    const breaches = result.lines.filter(
      (l) => affected.has(String(l.accountId)) && alertOn.includes(l.rag));
    for (const l of breaches) {
      const ccPart = l.costCenterId ? String(l.costCenterId) : '-';
      const ruleKey = `budget_variance:${result.budgetId}:${l.accountId}:${ccPart}`;
      await FinancialAlert.updateOne(
        { businessId, ruleKey, periodKey },
        {
          $setOnInsert: {
            businessId, ruleKey, periodKey,
            level: RAG_LEVEL[l.rag] || 'warning',
            title: `${l.accountName || 'An account'} is over budget`,
            what: `${l.accountName || 'An account'} spending is past its plan`,
            howMuch: `Actual ${l.actual} vs plan ${l.budget} (${l.variancePct != null ? Math.round(l.variancePct * 100) : '—'}% over)`,
            sinceWhen: periodKey,
            recommendation: 'Review this account on the Budget vs Actual page.',
            actionTo: '/budgets/variance',
            data: { budgetId: result.budgetId, accountId: l.accountId, costCenterId: l.costCenterId,
                    budget: l.budget, actual: l.actual, variance: l.variance, variancePct: l.variancePct },
            status: 'open', firedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
  }
}

module.exports = {
  actualsByLine, actualsByMonth, computeVariance, checkBreaches, ragFor, monthsElapsed, key,
};

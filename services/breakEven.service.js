// services/breakEven.service.js — FR-07.4 (pure compute + a read-only estimator)
'use strict';
const mongoose = require('mongoose');
const JournalEntry = require('../models/JournalEntry.model');
const { EFFECTIVE_LINES_STAGE, REPORT_STATUSES } = require('../repositories/transaction.repository');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const oid = (v) => new mongoose.Types.ObjectId(String(v));

function breakEvenPoint({ fixedCosts, pricePerUnit, variableCostPerUnit }) {
  const fc = Number(fixedCosts) || 0, p = Number(pricePerUnit) || 0, v = Number(variableCostPerUnit) || 0;
  const cmPerUnit = r2(p - v);
  if (cmPerUnit <= 0) return { feasible: false, reason: 'Price per unit must be greater than variable cost per unit.' };
  const exactUnits = fc / cmPerUnit;
  return {
    feasible: true,
    breakEvenUnits: Math.ceil(exactUnits),
    breakEvenUnitsExact: r2(exactUnits),
    breakEvenRevenue: r2(exactUnits * p),
    cmPerUnit,
    cmRatio: p ? r2(cmPerUnit / p) : null,
  };
}

function whatIf({ fixedCosts, pricePerUnit, variableCostPerUnit, expectedUnits = 0, targetProfit = 0 }) {
  const base = breakEvenPoint({ fixedCosts, pricePerUnit, variableCostPerUnit });
  const fc = Number(fixedCosts) || 0;
  if (!base.feasible) return { ...base, projectedProfit: null, unitsForTargetProfit: null };
  const cm = base.cmPerUnit;
  return {
    ...base,
    expectedUnits: Number(expectedUnits) || 0,
    projectedProfit: r2((Number(expectedUnits) || 0) * cm - fc),
    targetProfit: Number(targetProfit) || 0,
    unitsForTargetProfit: Math.ceil((fc + (Number(targetProfit) || 0)) / cm),
  };
}

async function estimateFromActuals(businessId, { from, to } = {}) {
  const match = { businessId: oid(businessId), status: { $in: REPORT_STATUSES }, isArchived: { $ne: true } };
  if (from || to) { match.transactionDate = {}; if (from) match.transactionDate.$gte = new Date(from); if (to) match.transactionDate.$lte = new Date(to); }
  const [row] = await JournalEntry.aggregate([
    { $match: match },
    EFFECTIVE_LINES_STAGE,
    { $unwind: '$effectiveLines' },
    { $lookup: { from: 'chartofaccounts', localField: 'effectiveLines.accountId', foreignField: '_id',
      as: 'acc', pipeline: [{ $project: { accountType: 1, accountSubtype: 1 } }] } },
    { $unwind: { path: '$acc', preserveNullAndEmptyArrays: true } },
    { $group: {
      _id: null,
      revenue: { $sum: { $cond: [{ $and: [{ $eq: ['$acc.accountType', 'Revenue'] }, { $eq: ['$effectiveLines.type', 'credit'] }] }, '$effectiveLines.amount', 0] } },
      variableCosts: { $sum: { $cond: [{ $and: [{ $eq: ['$acc.accountSubtype', 'Direct Cost'] }, { $eq: ['$effectiveLines.type', 'debit'] }] }, '$effectiveLines.amount', 0] } },
      fixedCosts: { $sum: { $cond: [{ $and: [{ $eq: ['$acc.accountType', 'Expense'] }, { $ne: ['$acc.accountSubtype', 'Direct Cost'] }, { $eq: ['$effectiveLines.type', 'debit'] }] }, '$effectiveLines.amount', 0] } },
    } },
  ]);
  return { revenue: r2(row?.revenue), variableCosts: r2(row?.variableCosts), fixedCosts: r2(row?.fixedCosts) };
}

module.exports = { breakEvenPoint, whatIf, estimateFromActuals };

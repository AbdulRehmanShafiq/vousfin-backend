// services/profitability.service.js — FR-07.3
'use strict';
const mongoose = require('mongoose');
const JournalEntry = require('../models/JournalEntry.model');
const { EFFECTIVE_LINES_STAGE, REPORT_STATUSES } = require('../repositories/transaction.repository');
const { ApiError } = require('../utils/ApiError');

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000; // ratios: keep 2dp of percent

const DIM_FIELD = {
  customer: '$customerId',
  product: '$inventoryItemId',
  cost_center: { $ifNull: ['$effectiveLines.costCenterId', '$costCenterId'] },
};

async function _names(businessId, dim, ids) {
  const real = ids.filter(Boolean).map((i) => oid(i));
  if (real.length === 0) return new Map();
  if (dim === 'customer') {
    const Customer = require('../models/Customer.model');
    const rows = await Customer.find({ businessId, _id: { $in: real } }).lean();
    return new Map(rows.map((r) => [String(r._id), r.name]));
  }
  if (dim === 'product') {
    const InventoryItem = require('../models/InventoryItem.model');
    const rows = await InventoryItem.find({ businessId, _id: { $in: real } }).lean();
    return new Map(rows.map((r) => [String(r._id), r.name]));
  }
  const ccRepo = require('../repositories/costCenter.repository');
  const rows = await ccRepo.findByBusiness(businessId);
  return new Map((rows || []).map((r) => [String(r._id), r.name]));
}

async function byDimension(businessId, dim, { from, to } = {}) {
  if (!DIM_FIELD[dim]) throw new ApiError(400, `Unknown profitability dimension "${dim}".`);
  const match = {
    businessId: oid(businessId),
    status: { $in: REPORT_STATUSES },
    isArchived: { $ne: true },
  };
  if (from || to) {
    match.transactionDate = {};
    if (from) match.transactionDate.$gte = new Date(from);
    if (to) match.transactionDate.$lte = new Date(to);
  }
  const rows = await JournalEntry.aggregate([
    { $match: match },
    EFFECTIVE_LINES_STAGE,
    { $unwind: '$effectiveLines' },
    { $lookup: { from: 'chartofaccounts', localField: 'effectiveLines.accountId', foreignField: '_id',
      as: 'acc', pipeline: [{ $project: { accountType: 1, accountSubtype: 1 } }] } },
    { $unwind: { path: '$acc', preserveNullAndEmptyArrays: true } },
    { $group: {
      _id: DIM_FIELD[dim],
      revenue: { $sum: { $cond: [{ $and: [{ $eq: ['$acc.accountType', 'Revenue'] }, { $eq: ['$effectiveLines.type', 'credit'] }] }, '$effectiveLines.amount', 0] } },
      variableCost: { $sum: { $cond: [{ $and: [{ $eq: ['$acc.accountSubtype', 'Direct Cost'] }, { $eq: ['$effectiveLines.type', 'debit'] }] }, '$effectiveLines.amount', 0] } },
    } },
  ]);

  const names = await _names(businessId, dim, rows.map((r) => r._id && String(r._id)));
  const segments = rows
    .filter((r) => r.revenue !== 0 || r.variableCost !== 0)
    .map((r) => {
      const revenue = r2(r.revenue); const variableCost = r2(r.variableCost);
      const grossMargin = r2(revenue - variableCost);
      return {
        id: r._id ? String(r._id) : null,
        name: r._id ? (names.get(String(r._id)) || 'Unknown') : 'Unassigned',
        revenue, variableCost, grossMargin,
        grossMarginPct: revenue ? r4(grossMargin / revenue) : null,
        contributionMargin: grossMargin,
        lossMaker: grossMargin < 0,
      };
    })
    .sort((a, b) => b.grossMargin - a.grossMargin);

  return {
    dim, from: from || null, to: to || null, segments,
    totals: {
      revenue: r2(segments.reduce((s, x) => s + x.revenue, 0)),
      variableCost: r2(segments.reduce((s, x) => s + x.variableCost, 0)),
      grossMargin: r2(segments.reduce((s, x) => s + x.grossMargin, 0)),
    },
  };
}

module.exports = { byDimension };

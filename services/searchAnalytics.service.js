'use strict';

/**
 * searchAnalytics.service.js — command-bar usage insight.
 * logSearch is best-effort and never throws (it must not break the search path).
 * getInsights powers the Admin "Search Insights" tab, whose no-result backlog
 * drives help-content authoring and synonym tuning.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');
const SearchLog = require('../models/SearchLog.model');
const logger = require('../config/logger');

function normalize(q) {
  return String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function toObjectId(value) {
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : value;
}

/** Record one search event. No userId is ever stored. Best-effort. */
async function logSearch({ businessId, kind = 'catalog', query, resultClickedId = null, noResult = false } = {}) {
  const text = normalize(query);
  if (!businessId || !text) return undefined;
  try {
    await SearchLog.create({
      businessId,
      kind,
      query: text,
      queryHash: crypto.createHash('sha256').update(text).digest('hex'),
      resultClickedId: resultClickedId || null,
      noResult: !!noResult,
    });
  } catch (err) {
    logger.warn(`[searchAnalytics] log failed (non-fatal): ${err.message}`);
  }
  return undefined;
}

async function getInsights(businessId, { days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86400000);
  const match = { businessId: toObjectId(businessId), createdAt: { $gte: since } };

  const [totalsAgg, topQueries, gaps] = await Promise.all([
    SearchLog.aggregate([
      { $match: match },
      { $group: { _id: null, searches: { $sum: 1 }, clicks: { $sum: { $cond: ['$resultClickedId', 1, 0] } }, noResults: { $sum: { $cond: ['$noResult', 1, 0] } } } },
    ]),
    SearchLog.aggregate([
      { $match: match },
      { $group: { _id: '$query', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]),
    SearchLog.aggregate([
      { $match: { ...match, noResult: true } },
      { $group: { _id: '$query', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]),
  ]);

  const t = totalsAgg[0] || { searches: 0, clicks: 0, noResults: 0 };
  return {
    totals: {
      searches: t.searches || 0,
      clicks: t.clicks || 0,
      noResults: t.noResults || 0,
      ctr: t.searches ? Math.round((t.clicks / t.searches) * 100) : 0,
    },
    topQueries: (topQueries || []).map((q) => ({ query: q._id, count: q.count })),
    gaps: (gaps || []).map((q) => ({ query: q._id, count: q.count })),
  };
}

module.exports = { logSearch, getInsights, normalize };

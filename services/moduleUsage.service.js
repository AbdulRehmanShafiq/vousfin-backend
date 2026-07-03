// services/moduleUsage.service.js — records which modules a user opens/searches
// and returns their most-used shortcuts for the dashboard. Best-effort: tracking
// is telemetry and must never break or slow navigation, so record() never throws.
'use strict';
const ModuleUsage = require('../models/ModuleUsage.model');
const { rankShortcuts } = require('../utils/moduleShortcuts.helper');
const logger = require('../config/logger');

/** Reinforce a module open/search. Never throws. */
async function record(businessId, userId, { moduleKey, label, path } = {}) {
  if (!businessId || !userId || !moduleKey || !label || !path) return;
  try {
    await ModuleUsage.findOneAndUpdate(
      { businessId, userId, moduleKey },
      { $inc: { count: 1 }, $set: { label: String(label).slice(0, 60), path: String(path).slice(0, 200), lastUsedAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (err) {
    logger.warn(`[moduleUsage] record failed (non-fatal): ${err.message}`);
  }
}

/** Ranked shortcuts (most-used, recency tie-break), capped. Returns [] on failure. */
async function getShortcuts(businessId, userId, { limit = 5 } = {}) {
  try {
    const rows = await ModuleUsage.find({ businessId, userId })
      .sort({ count: -1, lastUsedAt: -1 })
      .limit(20)
      .lean();
    return rankShortcuts(rows, { limit });
  } catch (err) {
    logger.warn(`[moduleUsage] getShortcuts failed (non-fatal): ${err.message}`);
    return [];
  }
}

module.exports = { record, getShortcuts };

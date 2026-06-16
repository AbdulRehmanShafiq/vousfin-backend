// services/feedback.service.js
//
// Autonomy roadmap Phase 1 — capture + summarise the learning signal. Every human
// verdict on a proposed action is recorded; getStats() rolls it up into the
// per-capability accuracy that drives the Autonomy Report and dial recommendations.
//
'use strict';
const mongoose = require('mongoose');
const logger = require('../config/logger');

const FeedbackEvent = () => mongoose.model('FeedbackEvent');

/** Record one verdict. Best-effort — learning must never break the main flow. */
async function record(payload) {
  try {
    return await FeedbackEvent().create({
      businessId:       payload.businessId,
      capability:       payload.capability,
      actionType:       payload.actionType || '',
      proposedActionId: payload.proposedActionId || null,
      verdict:          payload.verdict,
      confidence:       payload.confidence ?? null,
      correction:       payload.correction || null,
      performedBy:      payload.performedBy || null,
    });
  } catch (e) {
    logger.warn(`[feedback] record failed: ${e.message}`);
    return null;
  }
}

/**
 * Per-capability rollup: { [capability]: { total, approved, rejected, edited, accuracy } }.
 * accuracy = approved as-is / total (edited + rejected = the system got it wrong).
 */
async function getStats(businessId) {
  const rows = await FeedbackEvent().aggregate([
    { $match: { businessId: new mongoose.Types.ObjectId(String(businessId)) } },
    { $group: {
      _id: '$capability',
      total:    { $sum: 1 },
      approved: { $sum: { $cond: [{ $eq: ['$verdict', 'approved'] }, 1, 0] } },
      rejected: { $sum: { $cond: [{ $eq: ['$verdict', 'rejected'] }, 1, 0] } },
      edited:   { $sum: { $cond: [{ $eq: ['$verdict', 'edited'] }, 1, 0] } },
    } },
  ]);

  const out = {};
  for (const r of rows) {
    out[r._id] = {
      total: r.total, approved: r.approved, rejected: r.rejected, edited: r.edited,
      accuracy: r.total > 0 ? r.approved / r.total : 0,
    };
  }
  return out;
}

module.exports = { record, getStats };

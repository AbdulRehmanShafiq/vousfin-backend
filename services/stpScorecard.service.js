// services/stpScorecard.service.js — the STP (straight-through-processing)
// scorecard (Intelligence Roadmap Phase 3): per-tenant, windowed automation
// rates for posting, matching, reconciliation, and categorization.
//
// Read-only over existing records — it derives, never stores, so it can never
// disagree with the ledger (single source of truth). Each capability's count
// gathering is fault-isolated: one failing source reports "no signal" (null
// rate) instead of breaking the scorecard.
'use strict';
const JournalEntry = require('../models/JournalEntry.model');
const Bill = require('../models/Bill.model');
const BankStatement = require('../models/BankStatement.model');
const aiDecisionRepo = require('../repositories/aiDecision.repository');
const { computeStpScorecard } = require('../utils/stpMetrics.helper');
const { TRANSACTION_SOURCES } = require('../config/constants');
const logger = require('../config/logger');

const USER_INPUT_METHODS = ['form', 'nlp', 'excel', 'batch'];

async function safeCounts(name, fn) {
  try { return await fn(); }
  catch (err) {
    logger.warn(`[stpScorecard] ${name} counts failed (non-fatal): ${err.message}`);
    return { total: 0, automated: 0 };
  }
}

/**
 * @param {string} businessId
 * @param {{days?: number}} opts  trailing window (default 90 days)
 */
async function getScorecard(businessId, { days = 90 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [posting, matching, reconciliation, categorization] = await Promise.all([
    // Posting: of the user-originated entries, how many did the AI post itself?
    safeCounts('posting', async () => {
      const base = { businessId, createdAt: { $gte: since }, inputMethod: { $in: USER_INPUT_METHODS } };
      const [total, automated] = await Promise.all([
        JournalEntry.countDocuments(base),
        JournalEntry.countDocuments({ ...base, transactionSource: TRANSACTION_SOURCES.AI_AUTO_POSTED }),
      ]);
      return { total, automated };
    }),
    // Matching: of the bills the 3-way engine ran on, how many matched clean?
    safeCounts('matching', async () => {
      const base = { businessId, createdAt: { $gte: since }, threeWayMatchStatus: { $nin: ['none', 'pending'] } };
      const [total, automated] = await Promise.all([
        Bill.countDocuments(base),
        Bill.countDocuments({ ...base, threeWayMatchStatus: 'matched' }),
      ]);
      return { total, automated };
    }),
    // Reconciliation: of the resolved bank lines, how many did the engine match?
    safeCounts('reconciliation', async () => {
      const [row] = await BankStatement.aggregate([
        { $match: { businessId } },
        { $unwind: '$statementLines' },
        { $match: { 'statementLines.matchedAt': { $gte: since }, 'statementLines.status': { $ne: 'unmatched' } } },
        { $group: {
          _id: null,
          total: { $sum: 1 },
          automated: { $sum: { $cond: ['$statementLines.autoMatched', 1, 0] } },
        } },
      ]);
      return row || { total: 0, automated: 0 };
    }),
    // Categorization: of the resolved AI decisions, how many were accepted as-is?
    safeCounts('categorization', async () => {
      const b = await aiDecisionRepo.outcomeBreakdown(businessId);
      const resolved = b.accepted + b.corrected + b.reversed;
      return { total: resolved, automated: b.accepted };
    }),
  ]);

  return {
    ...computeStpScorecard({ posting, matching, reconciliation, categorization }),
    windowDays: days,
    asOf: new Date().toISOString(),
  };
}

module.exports = { getScorecard };

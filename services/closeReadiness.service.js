// services/closeReadiness.service.js — the close-readiness score (Intelligence
// Roadmap Phase 3: Continuous Close).
//
// Answers "can this month close cleanly, and if not, what exactly is in the
// way?" as a weighted, plain-language checklist over the engines that already
// exist: recognition schedules, fixed-asset depreciation, the approval queue,
// bank reconciliation, ledger integrity, and the AI review queue. Read-only —
// it never posts or closes anything itself. Each check is fault-isolated: a
// failing data source becomes a failed check ("couldn't verify"), never a
// crash, and NEVER a false pass — you can't close on unverified books.
'use strict';
const closeAgent = require('./closeAgent.service');
const fixedAssetService = require('./fixedAsset.service');
const ledgerIntegrity = require('./ledgerIntegrity.service');
const FixedAsset = require('../models/FixedAsset.model');
const PendingTransaction = require('../models/PendingTransaction.model');
const BankStatement = require('../models/BankStatement.model');
const aiDecisionRepo = require('../repositories/aiDecision.repository');
const { scoreReadiness } = require('../utils/closeReadiness.helper');
const logger = require('../config/logger');

// A source failure must read as "not verified" (blocks), never as "all clear".
async function safeCheck(key, fn) {
  try { return await fn(); }
  catch (err) {
    logger.warn(`[closeReadiness] ${key} check failed (non-fatal): ${err.message}`);
    return { ok: false, count: null, note: 'Could not verify — try again.' };
  }
}

/**
 * @returns {Promise<{closeable:boolean, period:object|null, score:number, ready:boolean, checks:Array, blockers:Array}>}
 */
async function getReadiness(businessId, now = new Date()) {
  const period = await closeAgent.findCloseablePeriod(businessId, now);
  if (!period) {
    return { closeable: false, period: null, score: 0, ready: false, checks: [], blockers: [] };
  }
  const periodEnd = new Date(period.endDate);

  const [recognitions, depreciation, approvals, bankLines, ledger, aiReview] = await Promise.all([
    safeCheck('recognitions', async () => {
      const count = await closeAgent.dueRecognitionCount(businessId, periodEnd);
      return { ok: count === 0, count };
    }),
    safeCheck('depreciation', async () => {
      const assets = await FixedAsset.find({ businessId, status: 'active' }).lean();
      const count = assets.filter((a) => fixedAssetService.isDepreciationDue(a, periodEnd)).length;
      return { ok: count === 0, count };
    }),
    safeCheck('approvals', async () => {
      const count = await PendingTransaction.countDocuments({ businessId, status: 'pending' });
      return { ok: count === 0, count };
    }),
    safeCheck('bankLines', async () => {
      const [row] = await BankStatement.aggregate([
        { $match: { businessId } },
        { $unwind: '$statementLines' },
        { $match: { 'statementLines.status': 'unmatched', 'statementLines.transactionDate': { $lte: periodEnd } } },
        { $count: 'count' },
      ]);
      const count = row?.count || 0;
      return { ok: count === 0, count };
    }),
    safeCheck('ledger', async () => {
      const drift = await ledgerIntegrity.computeDrift(businessId);
      const ok = drift.balanced && drift.driftedCount === 0;
      return { ok, count: drift.driftedCount, note: ok ? null : `Total drift ${drift.totalAbsDrift}` };
    }),
    safeCheck('aiReview', async () => {
      const b = await aiDecisionRepo.outcomeBreakdown(businessId);
      // Informational: pending AI reviews don't block a close, they just show up.
      return { ok: true, count: b.pending };
    }),
  ]);

  // Plain-language labels per the product-copy rule — an owner, not an
  // accountant, reads this checklist.
  const checks = [
    { key: 'recognitions', label: 'Scheduled income/expense entries posted', weight: 2, ...recognitions },
    { key: 'depreciation', label: 'Asset depreciation up to date',           weight: 2, ...depreciation },
    { key: 'approvals',    label: 'Nothing waiting for approval',            weight: 2, ...approvals },
    { key: 'bankLines',    label: 'Bank statement lines matched',            weight: 1, ...bankLines },
    { key: 'ledger',       label: 'Books balanced and consistent',           weight: 3, ...ledger },
    { key: 'aiReview',     label: 'AI decisions reviewed',                   weight: 1, ...aiReview },
  ];

  const { score, ready, blockers } = scoreReadiness(checks);
  return {
    closeable: true,
    period: { id: String(period._id), name: period.name || null, startDate: period.startDate, endDate: period.endDate },
    score, ready, checks, blockers,
    asOf: now.toISOString(),
  };
}

module.exports = { getReadiness };

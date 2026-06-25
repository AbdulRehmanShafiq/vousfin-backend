// jobs/bankReconciliation.job.js
//
// Phase 3 — Nightly Auto-Reconciliation.
//
// Scans every business that has imported bank statements with unmatched lines.
// For each, re-runs the matching engine (same scoring in bankReconciliation.service)
// against the latest ledger entries. High-confidence pairs are auto-linked.
//
// Safety: this job NEVER creates transactions or touches the ledger. It only
// updates BankStatement line statuses from 'unmatched' to 'matched'. The original
// ledger entries remain immutable.
//
'use strict';
const cron     = require('node-cron');
const os       = require('os');
const mongoose = require('mongoose');
const BankStatement = require('../models/BankStatement.model');
const transactionRepository = require('../repositories/transaction.repository');
const bankStatementRepository = require('../repositories/bankStatement.repository');
const logger   = require('../config/logger');
const {
  BANK_LINE_STATUS, BANK_LINE_DIRECTION,
  RECONCILIATION_MATCH, BANK_STATEMENT_STATUS,
} = require('../config/constants');

// ─── Distributed lock (same pattern as anomalyScan.job.js) ───────────────────
const LOCK_COLLECTION = 'cronlocks';
const LOCK_ID         = 'bank-recon-lock';
const LOCK_TTL_MS     = 4 * 60 * 60 * 1000; // 4 hours
const INSTANCE_ID     = `${os.hostname()}-${process.pid}`;

let CronLock;
const getCronLockModel = () => {
  if (CronLock) return CronLock;
  const schema = new mongoose.Schema({
    _id:         String,
    lockedBy:    String,
    lockedAt:    Date,
    lockedUntil: Date,
  }, { collection: LOCK_COLLECTION, _id: false, versionKey: false });
  CronLock = mongoose.models['CronLock'] || mongoose.model('CronLock', schema);
  return CronLock;
};

const acquireLock = async () => {
  const model = getCronLockModel();
  const now   = new Date();
  const until = new Date(Date.now() + LOCK_TTL_MS);
  try {
    const result = await model.findOneAndUpdate(
      { _id: LOCK_ID, $or: [{ lockedUntil: { $lt: now } }, { _id: { $exists: false } }] },
      { $set: { lockedBy: INSTANCE_ID, lockedAt: now, lockedUntil: until }, $setOnInsert: { _id: LOCK_ID } },
      { upsert: true, new: true },
    );
    return result?.lockedBy === INSTANCE_ID;
  } catch (err) {
    if (err.code === 11000) return false;
    logger.warn(`[bankReconJob] lock acquire error: ${err.message}`);
    return false;
  }
};

const releaseLock = async () => {
  try {
    const model = getCronLockModel();
    await model.deleteOne({ _id: LOCK_ID, lockedBy: INSTANCE_ID });
  } catch (err) {
    logger.warn(`[bankReconJob] lock release error: ${err.message}`);
  }
};

// ─── Scoring helpers (mirrors bankReconciliation.service.js) ─────────────────
const DAY = 86_400_000;
const tokens = (s) => String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
const idOf = (v) => String(v && v._id ? v._id : v);

function scoreCandidate(line, je, bankAccountId) {
  const b = String(bankAccountId);
  const dir = idOf(je.debitAccountId) === b ? BANK_LINE_DIRECTION.IN
            : idOf(je.creditAccountId) === b ? BANK_LINE_DIRECTION.OUT
            : null;
  if (dir !== line.direction) return null;

  const amt  = Number(je.baseCurrencyAmount || je.amount) || 0;
  const diff = Math.abs(amt - line.amount);
  const rel  = line.amount ? diff / line.amount : 1;
  let amountPts;
  if (diff <= 0.01)      amountPts = 60;
  else if (rel <= 0.01)  amountPts = 42;
  else if (rel <= 0.02)  amountPts = 25;
  else return null;
  const amountExact = diff <= 0.01;

  const days = Math.abs(new Date(je.transactionDate) - new Date(line.date)) / DAY;
  let datePts;
  if (days < 1)       datePts = 25;
  else if (days <= 2) datePts = 20;
  else if (days <= 5) datePts = 14;
  else if (days <= 10) datePts = 8;
  else if (days <= 20) datePts = 3;
  else datePts = 0;

  const lt = new Set(tokens(`${line.description} ${line.reference}`));
  const jt = tokens(`${je.description} ${je.transactionReference || ''} ${je.invoiceNumber || ''}`);
  let overlap = 0;
  for (const t of jt) if (lt.has(t)) overlap++;
  const denom = Math.max(1, Math.min(lt.size, jt.length) || 1);
  let textPts = Math.round(Math.min(1, overlap / denom) * 15);
  if (line.reference && jt.includes(String(line.reference).toLowerCase())) textPts = 15;

  return { score: amountPts + datePts + textPts, amountExact };
}

// ─── Core scan ───────────────────────────────────────────────────────────────
async function runAutoReconciliation() {
  // Find all statements that have at least one unmatched line
  const statements = await BankStatement.find({
    status: { $in: [BANK_STATEMENT_STATUS.IN_PROGRESS, 'imported'] },
    'lines.status': BANK_LINE_STATUS.UNMATCHED,
  });

  if (!statements.length) {
    logger.info('[bankReconJob] No statements with unmatched lines. Skipping.');
    return { statementsScanned: 0, newMatches: 0 };
  }

  let totalNewMatches = 0;

  for (const stmt of statements) {
    try {
      const unmatchedLines = stmt.lines.filter(l => l.status === BANK_LINE_STATUS.UNMATCHED);
      if (!unmatchedLines.length) continue;

      // Load ledger window
      const dates = unmatchedLines.map(l => new Date(l.date).getTime());
      const start = new Date(Math.min(...dates) - 20 * DAY);
      const end   = new Date(Math.max(...dates) + 20 * DAY);
      const entries = await transactionRepository.getByAccount(
        stmt.businessId, stmt.bankAccountId, start, end
      );

      // Collect already-used journal entry IDs across ALL this account's statements
      const usedIds = await bankStatementRepository.matchedJournalEntryIds(
        stmt.businessId, stmt.bankAccountId
      );

      let stmtMatches = 0;

      for (const line of unmatchedLines) {
        const ranked = [];
        for (const je of entries) {
          if (usedIds.has(String(je._id))) continue;
          const s = scoreCandidate(line, je, stmt.bankAccountId);
          if (s && s.score >= RECONCILIATION_MATCH.SUGGEST_MIN_SCORE) {
            ranked.push({ journalEntryId: je._id, score: s.score, amountExact: s.amountExact });
          }
        }
        ranked.sort((a, b) => b.score - a.score);

        const best   = ranked[0];
        const second = ranked[1];
        const confident = best && best.amountExact &&
          best.score >= RECONCILIATION_MATCH.AUTO_MIN_SCORE &&
          (!second || best.score - second.score >= RECONCILIATION_MATCH.AUTO_MIN_GAP);

        if (confident) {
          line.status = BANK_LINE_STATUS.MATCHED;
          line.matchedJournalEntryId = best.journalEntryId;
          line.matchScore  = best.score;
          line.autoMatched = true;
          line.matchedAt   = new Date();
          usedIds.add(String(best.journalEntryId));
          stmtMatches++;
        }
      }

      if (stmtMatches > 0) {
        // Check if all lines are now matched → mark statement as reconciled
        const stillUnmatched = stmt.lines.filter(l => l.status === BANK_LINE_STATUS.UNMATCHED).length;
        if (stillUnmatched === 0) {
          stmt.status = BANK_STATEMENT_STATUS.RECONCILED || 'reconciled';
        }
        await stmt.save();
        totalNewMatches += stmtMatches;
        logger.info(`[bankReconJob] Auto-matched ${stmtMatches} lines on statement ${stmt._id}`);
      }
    } catch (err) {
      logger.error(`[bankReconJob] Error processing statement ${stmt._id}: ${err.message}`);
    }
  }

  return { statementsScanned: statements.length, newMatches: totalNewMatches };
}

// ─── Cron schedule ───────────────────────────────────────────────────────────
function scheduleBankReconciliation() {
  // Daily at 01:30 AM server time
  cron.schedule('30 1 * * *', async () => {
    logger.info('[bankReconJob] Starting nightly auto-reconciliation...');
    const hasLock = await acquireLock();
    if (!hasLock) {
      logger.info('[bankReconJob] Another instance holds the lock. Skipping.');
      return;
    }
    try {
      const result = await runAutoReconciliation();
      logger.info(`[bankReconJob] Complete: ${result.statementsScanned} statements scanned, ${result.newMatches} new matches.`);
    } catch (err) {
      logger.error(`[bankReconJob] Fatal error: ${err.message}`);
    } finally {
      await releaseLock();
    }
  });
  logger.info('[bankReconJob] Scheduled nightly bank auto-reconciliation (01:30)');
}

module.exports = { scheduleBankReconciliation, runAutoReconciliation };

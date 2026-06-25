// jobs/dunningEscalation.job.js
//
// Phase 3 — Daily AR Dunning Escalation.
//
// Runs every morning at 07:30 and scans all overdue, unpaid invoices. For each
// invoice whose age has crossed a new dunning threshold, it advances the level:
//
//   0 none → 1 reminder (1d) → 2 first notice (15d) → 3 second notice (30d)
//          → 4 final notice (45d) → 5 collections (60d)
//
// Safety: This job delegates entirely to dunning.service.js which NEVER touches
// the ledger. It only updates dunning metadata on the Invoice document and emits
// a DUNNING_ESCALATED event (which can trigger email notifications via the event
// subscriber pipeline).
//
'use strict';
const cron     = require('node-cron');
const os       = require('os');
const mongoose = require('mongoose');
const dunningService = require('../services/dunning.service');
const Business       = require('../models/Business.model');
const logger         = require('../config/logger');

// ─── Distributed lock ────────────────────────────────────────────────────────
const LOCK_COLLECTION = 'cronlocks';
const LOCK_ID         = 'dunning-escalation-lock';
const LOCK_TTL_MS     = 2 * 60 * 60 * 1000; // 2 hours
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
    logger.warn(`[dunningJob] lock acquire error: ${err.message}`);
    return false;
  }
};

const releaseLock = async () => {
  try {
    const model = getCronLockModel();
    await model.deleteOne({ _id: LOCK_ID, lockedBy: INSTANCE_ID });
  } catch (err) {
    logger.warn(`[dunningJob] lock release error: ${err.message}`);
  }
};

// ─── Core scan ───────────────────────────────────────────────────────────────
async function runDunningEscalation() {
  const now = new Date();

  // Run the service-level escalation (it scans ALL businesses' overdue invoices)
  const stats = await dunningService.runEscalation(null, now);

  return stats;
}

// ─── Cron schedule ───────────────────────────────────────────────────────────
function scheduleDunningEscalation() {
  // Daily at 07:30 AM server time — after bank recon (01:30) and before business hours
  cron.schedule('30 7 * * *', async () => {
    logger.info('[dunningJob] Starting daily dunning escalation scan...');
    const hasLock = await acquireLock();
    if (!hasLock) {
      logger.info('[dunningJob] Another instance holds the lock. Skipping.');
      return;
    }
    try {
      const stats = await runDunningEscalation();
      logger.info(
        `[dunningJob] Complete: scanned ${stats.scanned} overdue invoices, ` +
        `escalated ${stats.escalated}. Breakdown: ${JSON.stringify(stats.byLevel)}`
      );
    } catch (err) {
      logger.error(`[dunningJob] Fatal error: ${err.message}`);
    } finally {
      await releaseLock();
    }
  });
  logger.info('[dunningJob] Scheduled daily dunning escalation (07:30)');
}

module.exports = { scheduleDunningEscalation, runDunningEscalation };

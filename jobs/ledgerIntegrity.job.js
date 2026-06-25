// jobs/ledgerIntegrity.job.js
const cron    = require('node-cron');
const os      = require('os');
const mongoose = require('mongoose');
const ledgerIntegrityService = require('../services/ledgerIntegrity.service');
const Business = require('../models/Business.model');
const logger  = require('../config/logger');

// ─── Distributed cron lock ─────────────────────────────────────────────────────
const LOCK_COLLECTION = 'cronlocks';
const LOCK_ID         = 'ledger-integrity-scan-lock';
const LOCK_TTL_MS     = 2 * 60 * 60 * 1000;  // 2 hours
const INSTANCE_ID     = `${os.hostname()}-${process.pid}`;

let CronLock;
const getCronLockModel = () => {
  if (CronLock) return CronLock;
  const schema = new mongoose.Schema({
    _id:          String,
    lockedBy:     String,
    lockedAt:     Date,
    lockedUntil:  Date,
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
      {
        _id: LOCK_ID,
        $or: [
          { lockedUntil: { $lt: now } },
          { _id: { $exists: false } },
        ],
      },
      {
        $set: { lockedBy: INSTANCE_ID, lockedAt: now, lockedUntil: until },
        $setOnInsert: { _id: LOCK_ID },
      },
      { upsert: true, new: true }
    );
    return !!result;
  } catch (err) {
    if (err.code === 11000) return false;
    logger.warn(`Ledger Integrity cron: lock acquisition error (${err.message}) — skipping to be safe`);
    return false;
  }
};

const releaseLock = async () => {
  const model = getCronLockModel();
  try {
    await model.deleteOne({ _id: LOCK_ID, lockedBy: INSTANCE_ID });
  } catch (err) {
    logger.warn(`Ledger Integrity cron: failed to release lock — ${err.message}`);
  }
};

const runIntegrityScan = async () => {
  logger.info('[LedgerIntegrityJob] Starting nightly ledger drift scan across all businesses...');
  
  if (!(await acquireLock())) {
    logger.info('[LedgerIntegrityJob] Another instance holds the lock. Skipping.');
    return;
  }

  try {
    // We only need to check active businesses
    const businesses = await Business.find({ isActive: true }).select('_id name').lean();
    let driftedCount = 0;

    for (const b of businesses) {
      const businessId = String(b._id);
      try {
        const drift = await ledgerIntegrityService.computeDrift(businessId);
        if (drift.driftedCount > 0 || !drift.balanced) {
          logger.error(`[CRITICAL] Ledger drift detected for business ${b.name} (${businessId})! Accounts drifted: ${drift.driftedCount}, Total Drift: ${drift.totalAbsDrift}, Balanced: ${drift.balanced}`);
          driftedCount++;
        }
      } catch (err) {
        logger.error(`[LedgerIntegrityJob] Failed to scan business ${b.name} (${businessId}): ${err.message}`);
      }
    }

    if (driftedCount === 0) {
      logger.info(`[LedgerIntegrityJob] Scan complete. 0 out of ${businesses.length} businesses have ledger drift.`);
    } else {
      logger.error(`[LedgerIntegrityJob] Scan complete. ${driftedCount} out of ${businesses.length} businesses have ledger drift.`);
    }

  } catch (error) {
    logger.error(`[LedgerIntegrityJob] Critical failure during scan: ${error.message}`);
  } finally {
    await releaseLock();
  }
};

const scheduleIntegrityScan = () => {
  // Run every night at 3:00 AM
  cron.schedule('0 3 * * *', () => {
    runIntegrityScan().catch(err => {
      logger.error(`[LedgerIntegrityJob] Unhandled error: ${err.message}`);
    });
  });
  logger.info('⏰ Nightly Ledger Integrity scan scheduled for 03:00 AM');
};

module.exports = { scheduleIntegrityScan, runIntegrityScan };

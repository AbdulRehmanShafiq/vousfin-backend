// jobs/fxRateSync.job.js
// Daily cron job: auto-fetch live exchange rates for every business at 08:00.
// Uses node-cron (already in dependencies). Errors are logged but never crash
// the server — FX sync is non-critical background work.
const cron        = require('node-cron');
const rateSyncSvc = require('../services/rateSync.service');
const logger      = require('../config/logger');

/**
 * Schedule the daily FX rate sync.
 * Cron: every day at 08:00 server time.
 * First-run: also kicks off an immediate sync on startup so the DB is never empty.
 */
function scheduleFxRateSync() {
  // ── Startup sync ──────────────────────────────────────────────────────────
  // Run once on boot (non-blocking, fire-and-forget) with a short delay so
  // the DB connection is definitely ready.
  setTimeout(async () => {
    logger.info('[FxRateSync] Running startup rate sync…');
    try {
      const stats = await rateSyncSvc.syncAllBusinesses();
      logger.info(`[FxRateSync] Startup sync done: ${stats.succeeded}/${stats.total} businesses`);
    } catch (err) {
      logger.warn(`[FxRateSync] Startup sync failed (non-fatal): ${err.message}`);
    }
  }, 8000); // 8-second delay after server boot

  // ── Daily schedule: every day at 08:00 ───────────────────────────────────
  cron.schedule('0 8 * * *', async () => {
    logger.info('[FxRateSync] Daily rate sync triggered by cron');
    try {
      const stats = await rateSyncSvc.syncAllBusinesses();
      logger.info(`[FxRateSync] Daily sync done: ${stats.succeeded}/${stats.total} businesses`);
    } catch (err) {
      logger.error(`[FxRateSync] Daily sync error: ${err.message}`);
    }
  });

  logger.info('⏰ FX rate sync job scheduled (daily 08:00 + immediate startup sync)');
}

module.exports = { scheduleFxRateSync };

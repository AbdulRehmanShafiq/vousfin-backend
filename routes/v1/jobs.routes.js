// Manual job-trigger endpoints for an external scheduler (e.g. cron-job.org).
// Serverless has no always-on process, so the node-cron jobs in server.js never
// fire in that deployment. These endpoints run the SAME logic on demand, so an
// external free scheduler can drive them on any cadence.
//
// Security: protected by a shared secret. The caller must send the secret in the
// `x-cron-secret` header (preferred) or a `?secret=` query param, matching the
// CRON_SECRET environment variable. If CRON_SECRET is unset the endpoints are
// disabled (fail closed). Lazy-requires avoid load-time cycles and keep cold
// starts light.
const express = require('express');
const logger = require('../../config/logger');

const router = express.Router();

// job name -> the callable that performs the work (same logic the cron uses)
const JOBS = {
  'payment-reminders':      () => require('../../jobs/paymentReminder.job').runOnce(),
  'fx-rate-sync':           () => require('../../services/rateSync.service').syncAllBusinesses(),
  'scheduled-reports':      () => require('../../jobs/scheduledReport.job').runDueReports(),
  'tax-snapshots':          () => require('../../jobs/taxSnapshot.job').runOnce(),
  'tax-return-autoprepare': () => require('../../jobs/taxReturnAutoPrepare.job').runOnce(),
  'anomaly-scan':           () => require('../../jobs/anomalyScan.job').scanAllActiveBusinesses(),
  'forecast-accuracy':      () => require('../../jobs/forecastAccuracy.job').runAccuracyCapture(),
  'forecast-materialize':   () => require('../../jobs/forecastMaterialize.job').runMaterializeSweep(),
  'forecast-retrain':       () => require('../../jobs/forecastRetrain.job').runRetrainSweep(),
  'compliance-reminders':   () => require('../../jobs/complianceReminder.job').runComplianceReminderJob(),
  'thirteen-week-cash':     async () => {
    const Business = require('../../models/Business.model');
    const svc = require('../../services/thirteenWeekCashFlow.service');
    const businesses = await Business.find({ status: 'active' }).select('_id').lean();
    const results = await Promise.allSettled(
      businesses.map(b => svc.buildForecast(String(b._id))),
    );
    return { processed: businesses.length, fulfilled: results.filter(r => r.status === 'fulfilled').length };
  },
};

// List available job names (no secret required — names only, no execution).
router.get('/', (req, res) => {
  res.status(200).json({ success: true, jobs: Object.keys(JOBS) });
});

// Trigger a job. Accepts GET or POST so simple URL-ping schedulers work too.
router.all('/run/:job', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(503).json({ success: false, message: 'Job triggers are disabled (CRON_SECRET is not set).' });
  }
  const provided = req.get('x-cron-secret') || req.query.secret;
  if (provided !== secret) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const run = JOBS[req.params.job];
  if (!run) {
    return res.status(404).json({
      success: false,
      message: `Unknown job "${req.params.job}".`,
      validJobs: Object.keys(JOBS),
    });
  }
  const started = Date.now();
  try {
    const result = await run();
    const ms = Date.now() - started;
    logger.info(`[jobs] manual trigger "${req.params.job}" ok in ${ms}ms`);
    return res.status(200).json({ success: true, job: req.params.job, ms, result: result ?? null });
  } catch (err) {
    logger.error(`[jobs] manual trigger "${req.params.job}" failed: ${err.message}`);
    return res.status(500).json({ success: false, job: req.params.job, message: err.message });
  }
});

module.exports = router;

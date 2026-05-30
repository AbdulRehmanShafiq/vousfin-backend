// jobs/forecastMaterialize.job.js
//
// Forecast Platform — F2. Nightly feature materialization.
//
// Pre-warms the feature store: for every active business, build + engineer +
// persist the full multi-source dataset at monthly + weekly grain so forecasts
// and backtests read ready-made point-in-time snapshots (no request-time ETL).
// One tenant failing never aborts the sweep.
//
'use strict';
const Business = require('../models/Business.model');
const featureStore = require('../services/forecasting/platform/featureStore.service');
const datasetBuilder = require('../services/forecasting/platform/datasetBuilder.service');
const logger = require('../config/logger');

const GRANULARITIES = ['monthly', 'weekly'];

async function runMaterializeSweep() {
  const businesses = await Business.find({ isActive: { $ne: false } }).select('_id').lean();
  const sources = datasetBuilder.sources.live;        // all live sources (F1 + F2)
  const stats = { businesses: businesses.length, materialized: 0, failed: 0 };

  for (const biz of businesses) {
    for (const granularity of GRANULARITIES) {
      try {
        await featureStore.materialize(biz._id, { granularity, sources, monthsBack: 24, datasetKey: 'core-financials' });
        stats.materialized++;
      } catch (err) {
        stats.failed++;
        logger.warn(`[forecastMaterialize] ${biz._id}/${granularity} failed: ${err.message}`);
      }
    }
  }
  logger.info(`[forecastMaterialize] sweep: ${stats.materialized} materialized · ${stats.failed} failed across ${stats.businesses} businesses`);
  return stats;
}

function scheduleForecastMaterialize() {
  const cron = require('node-cron');
  // Nightly 02:00 — pre-warm feature snapshots before the morning forecast load.
  cron.schedule('0 2 * * *', async () => {
    try { const r = await runMaterializeSweep(); logger.info(`[cron] feature materialization: ${r.materialized} datasets`); }
    catch (err) { logger.error(`[cron] forecastMaterialize error: ${err.message}`); }
  });
  logger.info('⏰ Forecast feature materialization job scheduled (nightly 02:00)');
}

module.exports = { runMaterializeSweep, scheduleForecastMaterialize };

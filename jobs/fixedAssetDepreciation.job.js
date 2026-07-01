// jobs/fixedAssetDepreciation.job.js
//
// Scheduled fixed-asset depreciation. Sweeps every active asset whose next
// annual depreciation period is due and posts DR 6230 Depreciation Expense /
// CR 1250 Accumulated Depreciation via the canonical compound poster.
//
// SAFE: idempotent (postDepreciation carries a per-year idempotency key, so a
// re-run never double-posts) and fault-isolated (one asset's failure never
// aborts the sweep). Cross-tenant by design — runs for all businesses at once.
//
// Invoked by:
//   • node-cron in server.js (local / long-running host), and
//   • cron-job.org via POST /api/v1/jobs/run/fixed-asset-depreciation (serverless).
'use strict';

const fixedAssetService = require('../services/fixedAsset.service');
const logger = require('../config/logger');

/** Run one depreciation sweep across all tenants. */
async function runOnce(asOf = new Date()) {
  const result = await fixedAssetService.runDueDepreciation(asOf);
  logger.info(
    `[fixedAssetDepreciation] scanned ${result.scanned}, due ${result.due}, posted ${result.posted}, `
    + `skipped ${result.skipped}, errors ${result.errors.length}`
  );
  if (result.errors.length) {
    for (const e of result.errors) {
      logger.warn(`[fixedAssetDepreciation] asset ${e.assetId} (biz ${e.businessId}) failed: ${e.error}`);
    }
  }
  return result;
}

module.exports = { runOnce };

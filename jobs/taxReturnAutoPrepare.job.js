// jobs/taxReturnAutoPrepare.job.js
//
// FR-04.3 (Phase 11) — autonomy: each day, for every tax-tracking business, any
// return whose deadline is exactly `autoPrepareDaysBefore` days away is auto-
// prepared from the GL and validated, so it's waiting (ready to review + file)
// before it's due. Idempotent: a period already past draft is skipped.
//
'use strict';
const cron = require('node-cron');
const Business        = require('../models/Business.model');
const taxReturnRepo   = require('../repositories/taxReturn.repository');
const returnPrepare   = require('../services/returnPrepare.service');
const returnValidator = require('../services/returnValidator.service');
const { getCalendar } = require('../config/taxFilingCalendar');
const { nextDeadline } = require('../utils/nextDeadline');
const { resolveTargetBusinessIds } = require('./taxSnapshot.job');
const logger = require('../config/logger');

// Calendar tax type → the return builder it maps to (others have no return).
const RETURN_TYPE_FOR = { GST: 'GST-01', WHT: 'WHT-165', INCOME_TAX: 'IT-RETURN' };

/** The period a return covers, derived from its filing deadline. */
function periodFor(rule, dueDate) {
  if (rule.frequency === 'annual') return { year: dueDate.getFullYear() };
  // Monthly returns file the PRIOR month (e.g. May GST is due ~18 June).
  const dm = dueDate.getMonth();              // 0-indexed filing month
  const month = dm === 0 ? 12 : dm;           // 1-indexed prior month
  const year  = dm === 0 ? dueDate.getFullYear() - 1 : dueDate.getFullYear();
  return { year, month };
}

/**
 * Prepare every return that is exactly N days from its deadline for one business.
 * @returns {Promise<{prepared:number, skipped:number}>}
 */
async function prepareDueForBusiness(businessId, asOf = new Date()) {
  const biz = await Business.findById(businessId).select('taxConfig').lean();
  const country    = (biz && biz.taxConfig && biz.taxConfig.country) || 'PK';
  const daysBefore = (biz && biz.taxConfig && biz.taxConfig.autoPrepareDaysBefore) || 5;

  const stats = { prepared: 0, skipped: 0 };
  for (const rule of getCalendar(country)) {
    const returnType = RETURN_TYPE_FOR[rule.taxType];
    if (!returnType) continue;

    const { dueDate, daysRemaining } = nextDeadline(rule, asOf);
    if (daysRemaining !== daysBefore) continue;

    const period = periodFor(rule, dueDate);
    const existing = await taxReturnRepo.findByPeriod(businessId, returnType, period);
    if (existing && existing.status !== 'draft') { stats.skipped += 1; continue; }

    const prepared = await returnPrepare.prepare(businessId, returnType, period, null);
    try { await returnValidator.validateReturn(businessId, prepared._id); } catch (e) { logger.warn(`[auto-prepare] validate failed: ${e.message}`); }
    stats.prepared += 1;
    logger.info(`[auto-prepare] ${returnType} ${period.year}-${period.month || ''} prepared for ${businessId} (due in ${daysBefore}d)`);
  }
  return stats;
}

/** Sweep every tax-tracking business. Public for tests + manual triggers. */
async function runOnce(asOf = new Date()) {
  const ids = await resolveTargetBusinessIds();
  const stats = { businesses: ids.length, prepared: 0, skipped: 0, errors: 0 };
  for (const id of ids) {
    try {
      const r = await prepareDueForBusiness(id, asOf);
      stats.prepared += r.prepared;
      stats.skipped  += r.skipped;
    } catch (e) {
      stats.errors += 1;
      logger.error(`[auto-prepare] business ${id} failed: ${e.message}`);
    }
  }
  logger.info(`[auto-prepare] swept ${stats.businesses}: prepared ${stats.prepared}, skipped ${stats.skipped}, errors ${stats.errors}`);
  return stats;
}

/** Register the daily schedule (06:45, after the snapshot + bill jobs). */
function scheduleAutoPrepare() {
  cron.schedule('45 6 * * *', () => {
    runOnce().catch(err => logger.error(`[auto-prepare] top-level: ${err.message}`));
  }, { timezone: process.env.CRON_TIMEZONE || 'Asia/Karachi' });
  logger.info('⏰ Tax-return auto-prepare cron scheduled (daily 06:45)');
}

module.exports = { prepareDueForBusiness, runOnce, scheduleAutoPrepare, periodFor, RETURN_TYPE_FOR };

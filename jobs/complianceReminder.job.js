// jobs/complianceReminder.job.js — FR-10.1
// For each active business: mark overdue obligations and surface 7-day reminders.
// No email sending — just marks + returns a summary for the scheduler log.
'use strict';
const complianceService = require('../services/compliance.service');
const Business = require('../models/Business.model');
const logger = require('../config/logger');

async function runComplianceReminderJob(businessId) {
  const summary = [];

  let businessIds;
  if (businessId) {
    businessIds = [businessId];
  } else {
    const businesses = await Business.find({ status: { $ne: 'deleted' } }, '_id').lean();
    businessIds = businesses.map((b) => b._id);
  }

  for (const bId of businessIds) {
    try {
      const overdueCount = await complianceService.checkAndMarkOverdue(bId);
      const upcoming = await complianceService.upcomingReminders(bId, 7);
      summary.push({ businessId: bId, overdueMarked: overdueCount, upcomingCount: upcoming.length });
      if (overdueCount > 0 || upcoming.length > 0) {
        logger.info(`[complianceReminder] biz=${bId} overdue=${overdueCount} upcoming7d=${upcoming.length}`);
      }
    } catch (err) {
      logger.error(`[complianceReminder] biz=${bId} error: ${err.message}`);
      summary.push({ businessId: bId, error: err.message });
    }
  }

  return summary;
}

module.exports = { runComplianceReminderJob };

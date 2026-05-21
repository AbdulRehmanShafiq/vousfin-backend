// jobs/anomalyScan.job.js
const cron = require('node-cron');
const aiPlaceholderService = require('../services/aiPlaceholder.service');
const userRepository = require('../repositories/user.repository');
const logger = require('../config/logger');
const config = require('../config');

/**
 * Run anomaly detection for a single business.
 * @param {string} businessId
 * @returns {Promise<Object>}
 */
const runScanForBusiness = async (businessId) => {
  try {
    const result = await aiPlaceholderService.anomalyScan(businessId);
    logger.info(`Anomaly scan for business ${businessId}: ${result.anomaliesFound} anomalies, ${result.alertsCreated} alerts created`);
    return result;
  } catch (error) {
    logger.error(`Anomaly scan failed for business ${businessId}: ${error.message}`);
    return { anomaliesFound: 0, alertsCreated: 0, error: error.message };
  }
};

/**
 * Scan all active businesses.
 * @returns {Promise<{totalBusinesses: number, totalAnomalies: number, totalAlerts: number}>}
 */
const scanAllActiveBusinesses = async () => {
  logger.info('Starting anomaly detection scan for all active businesses');
  const startTime = Date.now();

  // Get all active customers (users with role=customer and status=active who have businessId)
  const activeCustomers = await userRepository.findAll({
    role: 'customer',
    status: 'active',
    businessId: { $ne: null },
  });
  const businesses = activeCustomers.data.filter(u => u.businessId).map(u => u.businessId);
  
  if (businesses.length === 0) {
    logger.info('No active businesses found to scan');
    return { totalBusinesses: 0, totalAnomalies: 0, totalAlerts: 0 };
  }

  logger.info(`Found ${businesses.length} active businesses to scan`);
  let totalAnomalies = 0;
  let totalAlerts = 0;
  let succeeded = 0;

  for (const businessId of businesses) {
    const result = await runScanForBusiness(businessId);
    if (!result.error) {
      succeeded++;
      totalAnomalies += result.anomaliesFound || 0;
      totalAlerts += result.alertsCreated || 0;
    }
  }

  const duration = Date.now() - startTime;
  logger.info(`Anomaly scan completed: ${succeeded}/${businesses.length} businesses, ${totalAnomalies} anomalies, ${totalAlerts} alerts created in ${duration}ms`);
  
  return {
    totalBusinesses: businesses.length,
    succeeded,
    totalAnomalies,
    totalAlerts,
    duration,
  };
};

// /**
//  * Schedule the cron job.
//  * Default schedule: every 6 hours (0 */6 * * *)
//  * Read from config.ANOMALY_SCAN_CRON if provided.**/
 
const scheduleAnomalyScan = () => {
  const cronSchedule = config.ANOMALY_SCAN_CRON || '0 */6 * * *';
  
  cron.schedule(cronSchedule, async () => {
    logger.info(`Running scheduled anomaly scan at ${new Date().toISOString()}`);
    try {
      await scanAllActiveBusinesses();
    } catch (error) {
      logger.error(`Scheduled anomaly scan failed: ${error.message}`);
    }
  });
  
  logger.info(`Anomaly scan job scheduled with cron: ${cronSchedule}`);
};

module.exports = {
  scanAllActiveBusinesses,
  scheduleAnomalyScan,
};
// repositories/anomaly.repository.js
const BaseRepository = require('./base.repository');
const AnomalyAlert = require('../models/AnomalyAlert.model');
const { ANOMALY_STATUS } = require('../config/constants');
const { sanitizeAndValidateId } = require('../utils/sanitize.helper');
const logger = require('../config/logger');

class AnomalyRepository extends BaseRepository {
  constructor() {
    super(AnomalyAlert);
  }

  /**
   * Create a single anomaly alert.
   * @param {Object} data - { businessId, journalEntryId, anomalyScore, reason, featureVector, scanId }
   * @returns {Promise<Object>}
   */
  async createAlert(data) {
    if (!data.businessId || !data.journalEntryId || !data.anomalyScore || !data.scanId) {
      throw new Error('Missing required fields for anomaly alert');
    }
    return this.create(data);
  }

  /**
   * Bulk create alerts (for multiple flagged transactions in one scan).
   * @param {Array} alertsArray - Array of alert objects
   * @returns {Promise<Array>}
   */
  async bulkCreateAlerts(alertsArray) {
    if (!alertsArray || alertsArray.length === 0) return [];
    return this.model.insertMany(alertsArray, { ordered: false });
  }

  /**
   * Get pending (unreviewed) alerts for a business, with populated journal entry.
   * @param {string} businessId
   * @param {Object} pagination - { page, limit }
   * @returns {Promise<{data: Array, total: number, page: number, limit: number}>}
   */
  async getPendingAlerts(businessId, pagination = {}) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const { page = 1, limit = 25 } = pagination;
    const skip = (page - 1) * limit;
    const query = {
      businessId: validBusinessId,
      status: ANOMALY_STATUS.PENDING,
    };
    const [data, total] = await Promise.all([
      this.model.find(query)
        .populate('journalEntryId', 'description amount transactionDate transactionType')
        .sort({ detectedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.count(query),
    ]);
    return { data, total, page, limit };
  }

  /**
   * Get alerts for a business with optional status filter.
   * @param {string} businessId
   * @param {string} status - 'pending', 'valid', 'confirmed_issue' (optional)
   * @param {Object} pagination - { page, limit }
   * @returns {Promise<{data: Array, total: number, page: number, limit: number}>}
   */
  async getByBusiness(businessId, status = null, pagination = {}) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const { page = 1, limit = 25 } = pagination;
    const skip = (page - 1) * limit;
    const query = { businessId: validBusinessId };
    if (status && Object.values(ANOMALY_STATUS).includes(status)) {
      query.status = status;
    }
    const [data, total] = await Promise.all([
      this.model.find(query)
        .populate('journalEntryId', 'description amount transactionDate transactionType')
        .populate('reviewedBy', 'fullName email')
        .sort({ detectedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.count(query),
    ]);
    return { data, total, page, limit };
  }

  /**
   * Update the status of an anomaly alert (e.g., after user review).
   * @param {string} alertId
   * @param {string} status - 'valid' or 'confirmed_issue'
   * @param {string} reviewedBy - User ID of reviewer
   * @returns {Promise<Object|null>}
   */
  async updateAlertStatus(alertId, status, reviewedBy) {
    const validAlertId = sanitizeAndValidateId(alertId);
    if (!Object.values(ANOMALY_STATUS).includes(status)) {
      throw new Error(`Invalid status: ${status}`);
    }
    if (status === ANOMALY_STATUS.PENDING) {
      throw new Error('Cannot set status back to pending');
    }
    const validReviewer = sanitizeAndValidateId(reviewedBy);
    return this.update(validAlertId, {
      status,
      reviewedBy: validReviewer,
      reviewedAt: new Date(),
    });
  }

  /**
   * Get all alerts from a specific scan batch (for debugging or batch reprocessing).
   * @param {string} scanId - Unique identifier of the scan run
   * @param {string} businessId
   * @returns {Promise<Array>}
   */
  async getByScanId(scanId, businessId) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    return this.model.find({
      scanId,
      businessId: validBusinessId,
    })
      .populate('journalEntryId')
      .sort({ anomalyScore: 1 }) // most anomalous first (more negative)
      .lean();
  }

  /**
   * Get alerts that have been pending for longer than specified hours.
   * Used for reminder jobs.
   * @param {string} businessId
   * @param {number} hoursOld - Minimum age in hours
   * @returns {Promise<Array>}
   */
  async getStalePendingAlerts(businessId, hoursOld = 24) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - hoursOld);
    return this.model.find({
      businessId: validBusinessId,
      status: ANOMALY_STATUS.PENDING,
      detectedAt: { $lte: cutoff },
    })
      .populate('journalEntryId')
      .sort({ detectedAt: 1 })
      .lean();
  }

  /**
   * Get counts of alerts by status for a business (for notification badge).
   * @param {string} businessId
   * @returns {Promise<Object>} { pending: number, valid: number, confirmed_issue: number }
   */
  async countByBusinessAndStatus(businessId) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const result = await this.model.aggregate([
      { $match: { businessId: validBusinessId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const counts = {
      [ANOMALY_STATUS.PENDING]: 0,
      [ANOMALY_STATUS.VALID]: 0,
      [ANOMALY_STATUS.CONFIRMED_ISSUE]: 0,
    };
    result.forEach(item => {
      counts[item._id] = item.count;
    });
    return counts;
  }

  /**
   * Delete alerts older than a certain date (maintenance, if needed).
   * @param {Date} olderThan
   * @returns {Promise<number>}
   */
  async deleteOlderThan(olderThan) {
    const result = await this.model.deleteMany({ detectedAt: { $lt: olderThan } });
    logger.warn(`Deleted ${result.deletedCount} anomaly alerts older than ${olderThan}`);
    return result.deletedCount;
  }
}

module.exports = new AnomalyRepository();
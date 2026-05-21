// repositories/auditLog.repository.js
const BaseRepository = require('./base.repository');
const AuditLog = require('../models/AuditLog.model');
const { AUDIT_ACTIONS } = require('../config/constants');
const { sanitizeAndValidateId } = require('../utils/sanitize.helper');
const logger = require('../config/logger');

class AuditLogRepository extends BaseRepository {
  constructor() {
    super(AuditLog);
  }

  /**
   * Create a new audit log entry.
   * @param {Object} logData - { businessId, entityType, entityId, action, performedBy, performedByName, beforeState, afterState, ipAddress }
   * @returns {Promise<Object>}
   */
  async log(logData) {
    // Validate required fields
    if (!logData.entityType || !logData.entityId || !logData.action || !logData.performedBy) {
      throw new Error('Missing required fields for audit log');
    }
    const businessScoped = !['user'].includes(logData.entityType);
    if (businessScoped && !logData.businessId) {
      throw new Error('Missing required field: businessId');
    }
    return this.create(logData);
  }

  /**
   * Get audit trail for a specific entity (e.g., a journal entry).
   * @param {string} entityType - 'journalEntry', 'user', 'business', 'account'
   * @param {string} entityId
   * @param {Object} pagination - { page, limit }
   * @returns {Promise<{data: Array, total: number, page: number, limit: number}>}
   */
  async getForEntity(entityType, entityId, pagination = {}) {
    const { page = 1, limit = 25 } = pagination;
    const skip = (page - 1) * limit;
    const query = { entityType, entityId };
    const [data, total] = await Promise.all([
      this.model.find(query)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limit)
        .populate('performedBy', 'fullName email')
        .lean(),
      this.count(query),
    ]);
    return { data, total, page, limit };
  }

  /**
   * Get audit logs for a business with advanced filters.
   * @param {string} businessId
   * @param {Object} filters - { startDate, endDate, action, performedBy }
   * @param {Object} pagination - { page, limit }
   * @returns {Promise<{data: Array, total: number, page: number, limit: number}>}
   */
  async getByBusiness(businessId, filters = {}, pagination = {}) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const { page = 1, limit = 25 } = pagination;
    const skip = (page - 1) * limit;

    const query = { businessId: validBusinessId };
    if (filters.startDate || filters.endDate) {
      query.timestamp = {};
      if (filters.startDate) query.timestamp.$gte = new Date(filters.startDate);
      if (filters.endDate) query.timestamp.$lte = new Date(filters.endDate);
    }
    if (filters.action && Object.values(AUDIT_ACTIONS).includes(filters.action)) {
      query.action = filters.action;
    }
    if (filters.performedBy) {
      const validUserId = sanitizeAndValidateId(filters.performedBy);
      query.performedBy = validUserId;
    }

    const [data, total] = await Promise.all([
      this.model.find(query)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limit)
        .populate('performedBy', 'fullName email')
        .lean(),
      this.count(query),
    ]);
    return { data, total, page, limit };
  }

  /**
   * Get all export actions (PDF/Excel) for a business within a date range.
   * @param {string} businessId
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {Promise<Array>}
   */
  async getExportLogs(businessId, startDate, endDate) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    return this.model.find({
      businessId: validBusinessId,
      action: AUDIT_ACTIONS.EXPORTED,
      timestamp: { $gte: startDate, $lte: endDate },
    })
      .sort({ timestamp: -1 })
      .populate('performedBy', 'fullName email')
      .lean();
  }

  /**
   * Get summary of user actions grouped by action type.
   * @param {string} businessId
   * @param {string} userId
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {Promise<Array<{action: string, count: number}>>}
   */
  async getUserActionSummary(businessId, userId, startDate, endDate) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const validUserId = sanitizeAndValidateId(userId);
    const result = await this.model.aggregate([
      {
        $match: {
          businessId: validBusinessId,
          performedBy: validUserId,
          timestamp: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: '$action',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);
    return result.map(item => ({ action: item._id, count: item.count }));
  }

  /**
   * Delete old audit logs beyond a retention period.
   * Use with caution – financial logs often have legal retention requirements.
   * @param {number} retentionDays - Delete logs older than this many days
   * @returns {Promise<number>} Number of deleted records
   */
  async deleteOlderThan(retentionDays) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    const result = await this.model.deleteMany({ timestamp: { $lt: cutoffDate } });
    logger.warn(`Deleted ${result.deletedCount} audit logs older than ${retentionDays} days`);
    return result.deletedCount;
  }
}

module.exports = new AuditLogRepository();
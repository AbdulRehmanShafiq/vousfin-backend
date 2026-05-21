// services/audit.service.js
const auditLogRepository = require('../repositories/auditLog.repository');
const userRepository = require('../repositories/user.repository');
const { ApiError } = require('../utils/ApiError');
const { AUDIT_ACTIONS, ENTITY_TYPES, USER_STATUS } = require('../config/constants');
const logger = require('../config/logger');

class AuditService {
  /**
   * Core logging method – creates an audit log entry.
   * Automatically fills performedByName if missing.
   * @param {Object} logData - { businessId, entityType, entityId, action, performedBy, performedByName, beforeState, afterState, ipAddress }
   * @returns {Promise<Object>}
   */
  async log(logData) {
    // Validate required fields
    const required = ['entityType', 'entityId', 'action', 'performedBy'];
    for (const field of required) {
      if (!logData[field]) {
        throw new ApiError(500, `Audit log missing required field: ${field}`);
      }
    }
    const businessScoped = !['user'].includes(logData.entityType);
    if (businessScoped && !logData.businessId) {
      throw new ApiError(500, 'Audit log missing required field: businessId');
    }

    // Ensure performedByName is present
    if (!logData.performedByName || !String(logData.performedByName).trim()) {
      const user = await userRepository.findById(logData.performedBy);
      logData.performedByName = user ? user.fullName : 'Unknown User';
    }

    // Ensure timestamp is set (repository will set default if not provided)
    const entry = await auditLogRepository.log(logData);
    logger.debug(`Audit log created: ${logData.action} on ${logData.entityType}/${logData.entityId}`);
    return entry;
  }

  /**
   * Log a creation action.
   * @param {string} entityType - e.g., 'journalEntry', 'user', 'business'
   * @param {string} entityId
   * @param {string} businessId
   * @param {string} performedBy - User ID
   * @param {Object} afterState - The created object (sanitised)
   * @param {string} ipAddress
   * @returns {Promise<Object>}
   */
  async logCreate(entityType, entityId, businessId, performedBy, afterState, ipAddress) {
    return this.log({
      businessId,
      entityType,
      entityId,
      action: AUDIT_ACTIONS.CREATED,
      performedBy,
      beforeState: null,
      afterState,
      ipAddress,
    });
  }

  /**
   * Log an update action.
   * @param {string} entityType
   * @param {string} entityId
   * @param {string} businessId
   * @param {string} performedBy
   * @param {Object} beforeState
   * @param {Object} afterState
   * @param {string} ipAddress
   * @returns {Promise<Object>}
   */
  async logUpdate(entityType, entityId, businessId, performedBy, beforeState, afterState, ipAddress) {
    return this.log({
      businessId,
      entityType,
      entityId,
      action: AUDIT_ACTIONS.EDITED,
      performedBy,
      beforeState,
      afterState,
      ipAddress,
    });
  }

  /**
   * Log a deletion or reversal action.
   * @param {string} entityType
   * @param {string} entityId
   * @param {string} businessId
   * @param {string} performedBy
   * @param {Object} beforeState
   * @param {string} ipAddress
   * @returns {Promise<Object>}
   */
  async logDelete(entityType, entityId, businessId, performedBy, beforeState, ipAddress) {
    return this.log({
      businessId,
      entityType,
      entityId,
      action: AUDIT_ACTIONS.DELETED,
      performedBy,
      beforeState,
      afterState: null,
      ipAddress,
    });
  }

  /**
   * Log a reversal (specialised delete for journal entries).
   * @param {string} entityType
   * @param {string} entityId
   * @param {string} businessId
   * @param {string} performedBy
   * @param {Object} beforeState
   * @param {Object} reversalInfo - { reversalId, reversalEntry }
   * @param {string} ipAddress
   * @returns {Promise<Object>}
   */
  async logReversal(entityType, entityId, businessId, performedBy, beforeState, reversalInfo, ipAddress) {
    return this.log({
      businessId,
      entityType,
      entityId,
      action: AUDIT_ACTIONS.REVERSED,
      performedBy,
      beforeState,
      afterState: reversalInfo,
      ipAddress,
    });
  }

  /**
   * Log an export action (PDF/Excel).
   * @param {string} entityType - e.g., 'report'
   * @param {string} entityId - Report type or export ID
   * @param {string} businessId
   * @param {string} performedBy
   * @param {Object} exportDetails - { reportName, format, dateRange }
   * @param {string} ipAddress
   * @returns {Promise<Object>}
   */
  async logExport(entityType, entityId, businessId, performedBy, exportDetails, ipAddress) {
    return this.log({
      businessId,
      entityType,
      entityId,
      action: AUDIT_ACTIONS.EXPORTED,
      performedBy,
      beforeState: null,
      afterState: exportDetails,
      ipAddress,
    });
  }

  /**
   * Log a user or account status change (suspend/reinstate).
   * @param {string} entityType
   * @param {string} entityId
   * @param {string} businessId
   * @param {string} performedBy
   * @param {string} oldStatus
   * @param {string} newStatus
   * @param {string} ipAddress
   * @returns {Promise<Object>}
   */
  async logStatusChange(entityType, entityId, businessId, performedBy, oldStatus, newStatus, ipAddress) {
    const action =
      newStatus === USER_STATUS.SUSPENDED ? AUDIT_ACTIONS.SUSPENDED : AUDIT_ACTIONS.EDITED;
    const entry = {
      entityType,
      entityId,
      action,
      performedBy,
      beforeState: { status: oldStatus },
      afterState: { status: newStatus },
      ipAddress,
    };
    if (businessId) entry.businessId = businessId;
    return this.log(entry);
  }

  /**
   * Retrieve audit trail for a specific entity.
   * @param {string} entityType
   * @param {string} entityId
   * @param {Object} pagination - { page, limit }
   * @returns {Promise<Object>}
   */
  async getAuditTrail(entityType, entityId, pagination = {}) {
    return auditLogRepository.getForEntity(entityType, entityId, pagination);
  }

  /**
   * Get all audit logs for a business with filtering.
   * @param {string} businessId
   * @param {Object} filters - { startDate, endDate, action, performedBy }
   * @param {Object} pagination
   * @returns {Promise<Object>}
   */
  async getBusinessLogs(businessId, filters = {}, pagination = {}) {
    return auditLogRepository.getByBusiness(businessId, filters, pagination);
  }

  /**
   * Get export logs specifically (for compliance).
   * @param {string} businessId
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {Promise<Array>}
   */
  async getExportLogs(businessId, startDate, endDate) {
    return auditLogRepository.getExportLogs(businessId, startDate, endDate);
  }
}

module.exports = new AuditService();
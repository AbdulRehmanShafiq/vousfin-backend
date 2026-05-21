// models/AuditLog.model.js
const mongoose = require('mongoose');
const { AUDIT_ACTIONS, ENTITY_TYPES } = require('../config/constants');

/**
 * AuditLog Schema
 * Append-only log of all user and system actions.
 * No updates or deletions are ever performed on this collection.
 */
const auditLogSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: false,
      default: null,
      index: true,
    },
    entityType: {
      type: String,
      enum: Object.values(ENTITY_TYPES),
      required: true,
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: Object.values(AUDIT_ACTIONS),
      required: true,
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    performedByName: {
      type: String,
      required: true, // denormalised for quick display
    },
    beforeState: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    afterState: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    ipAddress: {
      type: String,
      default: null,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    // No timestamps (we use custom timestamp field), but we can add createdAt for consistency
    timestamps: false,
    toJSON: {
      transform: (doc, ret) => {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// ===============================
// Indexes (optimized for audit trail queries)
// ===============================
// Find all actions on a specific entity
auditLogSchema.index({ entityType: 1, entityId: 1, timestamp: -1 });
// Find actions by user
auditLogSchema.index({ performedBy: 1, timestamp: -1 });
// Find actions by business for a date range
auditLogSchema.index({ businessId: 1, timestamp: -1 });
// Compound index for reporting: business + action + date
auditLogSchema.index({ businessId: 1, action: 1, timestamp: -1 });

// ===============================
// Statics (no instance methods – append only)
// ===============================

/**
 * Create a new audit log entry.
 * @param {Object} logData
 * @returns {Promise<AuditLog>}
 */
auditLogSchema.statics.log = async function (logData) {
  const log = new this(logData);
  return log.save();
};

/**
 * Get audit trail for a specific entity (e.g., a journal entry).
 * @param {string} entityType
 * @param {string} entityId
 * @param {Object} options - pagination { page, limit }
 * @returns {Promise<Array>}
 */
auditLogSchema.statics.getForEntity = async function (entityType, entityId, options = {}) {
  const { page = 1, limit = 25 } = options;
  const skip = (page - 1) * limit;
  return this.find({ entityType, entityId })
    .sort({ timestamp: -1 })
    .skip(skip)
    .limit(limit);
};

/**
 * Get audit log by business (for admin or customer audit reports).
 * @param {string} businessId
 * @param {Object} filters - { startDate, endDate, action, performedBy }
 * @param {Object} pagination
 * @returns {Promise<{data: Array, total: number}>}
 */
auditLogSchema.statics.getByBusiness = async function (businessId, filters = {}, pagination = {}) {
  const { page = 1, limit = 25 } = pagination;
  const skip = (page - 1) * limit;
  const query = { businessId };
  if (filters.startDate || filters.endDate) {
    query.timestamp = {};
    if (filters.startDate) query.timestamp.$gte = filters.startDate;
    if (filters.endDate) query.timestamp.$lte = filters.endDate;
  }
  if (filters.action) query.action = filters.action;
  if (filters.performedBy) query.performedBy = filters.performedBy;

  const [data, total] = await Promise.all([
    this.find(query).sort({ timestamp: -1 }).skip(skip).limit(limit),
    this.countDocuments(query),
  ]);
  return { data, total, page, limit };
};

// ===============================
// Pre-save Middleware (ensure no updates/deletes – but we rely on code discipline)
// ===============================
auditLogSchema.pre('save', function () {
  if (!this.timestamp) this.timestamp = new Date();
});

// ===============================
// Prevent updates to audit logs (optional but recommended)
// ===============================
auditLogSchema.pre('updateOne', function () {
  throw new Error('Audit logs are immutable – updates not allowed');
});
auditLogSchema.pre('updateMany', function () {
  throw new Error('Audit logs are immutable – updates not allowed');
});
auditLogSchema.pre('findOneAndUpdate', function () {
  throw new Error('Audit logs are immutable – updates not allowed');
});
auditLogSchema.pre('deleteOne', function () {
  throw new Error('Audit logs are immutable – deletions not allowed');
});
auditLogSchema.pre('deleteMany', function () {
  throw new Error('Audit logs are immutable – deletions not allowed');
});

// ===============================
// Model Export
// ===============================
const AuditLog = mongoose.model('AuditLog', auditLogSchema);

module.exports = AuditLog;
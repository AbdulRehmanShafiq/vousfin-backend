// models/AnomalyAlert.model.js
const mongoose = require('mongoose');
const { ANOMALY_STATUS } = require('../config/constants');

/**
 * AnomalyAlert Schema
 * Stores flagged transactions from Isolation Forest anomaly detection.
 * Users can review and classify each alert.
 */
const anomalyAlertSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    journalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      required: true,
      index: true,
    },
    anomalyScore: {
      type: Number,
      required: true,
      // Negative scores indicate more anomalous (Isolation Forest convention)
    },
    reason: {
      type: String,
      required: true,
      trim: true,
    },
    featureVector: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      // Stores the feature values used for detection: 
      // { amount, dayOfWeek, transactionType, accountPairFreq, interval }
    },
    status: {
      type: String,
      enum: Object.values(ANOMALY_STATUS),
      default: ANOMALY_STATUS.PENDING,
      required: true,
      index: true,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    detectedAt: {
      type: Date,
      default: Date.now,
      required: true,
      index: true,
    },
    scanId: {
      type: String,
      required: true,
      index: true,
    },
  },
  {
    timestamps: false, // using custom detectedAt
    toJSON: {
      transform: (doc, ret) => {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// ===============================
// Indexes
// ===============================
// For listing pending alerts for a business
anomalyAlertSchema.index({ businessId: 1, status: 1, detectedAt: -1 });
// For finding alerts by scan batch
anomalyAlertSchema.index({ scanId: 1 });
// For counting alerts per business (admin dashboard)
anomalyAlertSchema.index({ businessId: 1, detectedAt: -1 });

// ===============================
// Instance Methods
// ===============================

/**
 * Mark alert as reviewed with classification.
 * @param {string} userId - ID of the reviewing user
 * @param {string} classification - 'valid' or 'confirmed_issue'
 * @returns {Promise<AnomalyAlert>}
 */
anomalyAlertSchema.methods.review = async function (userId, classification) {
  if (!Object.values(ANOMALY_STATUS).includes(classification)) {
    throw new Error('Invalid classification');
  }
  this.status = classification;
  this.reviewedBy = userId;
  this.reviewedAt = new Date();
  return this.save();
};

// ===============================
// Statics
// ===============================

/**
 * Get all pending (unreviewed) alerts for a business.
 * @param {string} businessId
 * @param {Object} options - pagination
 * @returns {Promise<Array>}
 */
anomalyAlertSchema.statics.getPendingAlerts = async function (businessId, options = {}) {
  const { page = 1, limit = 25 } = options;
  const skip = (page - 1) * limit;
  return this.find({ businessId, status: ANOMALY_STATUS.PENDING })
    .sort({ detectedAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('journalEntryId');
};

/**
 * Get all alerts for a business (paginated) with optional status filter.
 * @param {string} businessId
 * @param {string} status - pending, valid, confirmed_issue
 * @param {Object} pagination
 * @returns {Promise<{data: Array, total: number}>}
 */
anomalyAlertSchema.statics.getByBusiness = async function (businessId, status = null, pagination = {}) {
  const { page = 1, limit = 25 } = pagination;
  const skip = (page - 1) * limit;
  const query = { businessId };
  if (status && Object.values(ANOMALY_STATUS).includes(status)) {
    query.status = status;
  }
  const [data, total] = await Promise.all([
    this.find(query).sort({ detectedAt: -1 }).skip(skip).limit(limit).populate('journalEntryId'),
    this.countDocuments(query),
  ]);
  return { data, total, page, limit };
};

/**
 * Get anomaly alerts that are still pending and older than a certain time (for reminders).
 * @param {string} businessId
 * @param {number} hoursAgo
 * @returns {Promise<Array>}
 */
anomalyAlertSchema.statics.getStalePendingAlerts = function (businessId, hoursAgo = 24) {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - hoursAgo);
  return this.find({
    businessId,
    status: ANOMALY_STATUS.PENDING,
    detectedAt: { $lte: cutoff },
  }).sort({ detectedAt: 1 });
};

// ===============================
// Pre-save Middleware
// ===============================
anomalyAlertSchema.pre('save', function () {
  if (!this.detectedAt) this.detectedAt = new Date();
});

// ===============================
// Model Export
// ===============================
const AnomalyAlert = mongoose.model('AnomalyAlert', anomalyAlertSchema);

module.exports = AnomalyAlert;
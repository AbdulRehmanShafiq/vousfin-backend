// models/Business.model.js
const mongoose = require('mongoose');
const { BUSINESS_TYPES, DEFAULT_CURRENCY, FISCAL_YEAR_START_MONTH_DEFAULT } = require('../config/constants');

/**
 * Business Schema
 * Represents a business profile owned by a user (customer)
 */
const businessSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true, // one user can have only one business (as per documentation)
      index: true,
    },
    businessName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    registrationNumber: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },
    businessType: {
      type: String,
      enum: BUSINESS_TYPES,
      required: true,
    },
    currency: {
      type: String,
      required: true,
      default: DEFAULT_CURRENCY,
      uppercase: true,
      trim: true,
    },
    fiscalYearStartMonth: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
      default: FISCAL_YEAR_START_MONTH_DEFAULT,
    },
    logoUrl: {
      type: String,
      default: null,
      trim: true,
    },
  },
  {
    timestamps: true,
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
// For admin queries listing businesses by user
businessSchema.index({ userId: 1, businessName: 1 });
// For searching businesses by name (case-insensitive – MongoDB does not support case-insensitive index by default, but we can add a collation or use regex; for performance we can create a separate text index)
businessSchema.index({ businessName: 'text' }); // optional: text search

// ===============================
// Virtuals
// ===============================
businessSchema.virtual('user', {
  ref: 'User',
  localField: 'userId',
  foreignField: '_id',
  justOne: true,
});

// ===============================
// Instance Methods
// ===============================

/**
 * Check if business has enough transaction history (for AI features)
 * This method is a placeholder – actual check should count journal entries.
 * @param {number} minMonths - Minimum months of history required
 * @returns {Promise<boolean>}
 */
businessSchema.methods.hasSufficientHistory = async function (minMonths = 3) {
  const JournalEntry = mongoose.model('JournalEntry');
  const oldestDate = new Date();
  oldestDate.setMonth(oldestDate.getMonth() - minMonths);
  const count = await JournalEntry.countDocuments({
    businessId: this._id,
    transactionDate: { $lte: oldestDate },
    status: 'posted',
  });
  return count > 0;
};

// ===============================
// Statics
// ===============================

/**
 * Find business by user ID with populated user data (optional)
 * @param {string} userId
 * @returns {Promise<Business>}
 */
businessSchema.statics.findByUserId = function (userId) {
  return this.findOne({ userId }).populate('user');
};

/**
 * Get all businesses with pagination and search (for admin)
 * @param {Object} options - { page, limit, search }
 * @returns {Promise<{data: Array, total: number}>}
 */
businessSchema.statics.findAllPaginated = async function (options = {}) {
  const { page = 1, limit = 25, search = '' } = options;
  const skip = (page - 1) * limit;
  const query = {};
  if (search) {
    query.$or = [
      { businessName: { $regex: search, $options: 'i' } },
    ];
  }
  const [data, total] = await Promise.all([
    this.find(query).skip(skip).limit(limit).sort('-createdAt'),
    this.countDocuments(query),
  ]);
  return { data, total, page, limit };
};

// ===============================
// Pre-save Middleware
// ===============================
businessSchema.pre('save', function () {
  if (this.currency) {
    this.currency = this.currency.toUpperCase();
  }
  if (this.businessName) {
    this.businessName = this.businessName.trim();
  }
});

// ===============================
// Model Export
// ===============================
const Business = mongoose.model('Business', businessSchema);

module.exports = Business;
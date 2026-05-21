// models/ChartOfAccount.model.js
const mongoose = require('mongoose');
const { ACCOUNT_TYPES, NORMAL_BALANCE } = require('../config/constants');

/**
 * ChartOfAccount Schema
 * Represents individual accounts (e.g., Cash, Rent Expense) linked to a business.
 * Stores running balance for quick reporting.
 */
const chartOfAccountSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    accountName: {
      type: String,
      required: true,
      trim: true,
    },
    accountType: {
      type: String,
      enum: Object.values(ACCOUNT_TYPES),
      required: true,
    },
    normalBalance: {
      type: String,
      enum: Object.values(NORMAL_BALANCE),
      required: true,
    },
    isDefault: {
      type: Boolean,
      default: false, // true for auto-generated default accounts
    },
    runningBalance: {
      type: Number,
      default: 0,
      min: 0, // Not strictly enforced (can be negative for liabilities/equity), but kept as a hint
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
// Ensure account names are unique per business
chartOfAccountSchema.index({ businessId: 1, accountName: 1 }, { unique: true });
// Index for filtering by account type (e.g., all Asset accounts)
chartOfAccountSchema.index({ businessId: 1, accountType: 1 });
// Index for normal balance (used in report generation)
chartOfAccountSchema.index({ businessId: 1, normalBalance: 1 });

// ===============================
// Virtuals
// ===============================
chartOfAccountSchema.virtual('business', {
  ref: 'Business',
  localField: 'businessId',
  foreignField: '_id',
  justOne: true,
});

// ===============================
// Instance Methods
// ===============================

/**
 * Update running balance by adding/subtracting an amount.
 * @param {number} amount - Positive for debit increases, negative for credit increases? Handled by service.
 * @returns {Promise<ChartOfAccount>}
 */
chartOfAccountSchema.methods.updateBalance = async function (delta) {
  this.runningBalance += delta;
  await this.save();
  return this;
};

// ===============================
// Statics
// ===============================

/**
 * Get all accounts for a business, optionally filtered by type.
 * @param {string} businessId
 * @param {string} accountType - Optional, one of ACCOUNT_TYPES
 * @returns {Promise<Array>}
 */
chartOfAccountSchema.statics.findByBusiness = function (businessId, accountType = null) {
  const query = { businessId };
  if (accountType && Object.values(ACCOUNT_TYPES).includes(accountType)) {
    query.accountType = accountType;
  }
  return this.find(query).sort('accountName');
};

/**
 * Get default Chart of Accounts for a new business.
 * Used during business setup to seed default accounts.
 * @returns {Promise<Array>} List of default account objects (without businessId)
 */
chartOfAccountSchema.statics.getDefaultAccounts = function () {
  const { DEFAULT_ACCOUNTS } = require('../config/constants');
  return DEFAULT_ACCOUNTS;
};

/**
 * Bulk insert default accounts for a business.
 * @param {string} businessId
 * @returns {Promise<Array>}
 */
chartOfAccountSchema.statics.seedDefaultAccounts = async function (businessId) {
  const defaultAccounts = this.getDefaultAccounts();
  const accountsToInsert = defaultAccounts.map(acc => ({
    ...acc,
    businessId,
    runningBalance: 0,
  }));
  return this.insertMany(accountsToInsert);
};

/**
 * Get total balance for all accounts of a given type (e.g., total Assets).
 * Used in Balance Sheet generation.
 * @param {string} businessId
 * @param {string} accountType
 * @returns {Promise<number>}
 */
chartOfAccountSchema.statics.getTotalBalanceByType = async function (businessId, accountType) {
  const result = await this.aggregate([
    { $match: { businessId, accountType } },
    { $group: { _id: null, total: { $sum: '$runningBalance' } } },
  ]);
  return result.length > 0 ? result[0].total : 0;
};

// ===============================
// Pre-save Middleware
// ===============================
chartOfAccountSchema.pre('save', function () {
  if (this.accountName) {
    this.accountName = this.accountName.trim().replace(/\b\w/g, (l) => l.toUpperCase());
  }
});

// ===============================
// Model Export
// ===============================
const ChartOfAccount = mongoose.model('ChartOfAccount', chartOfAccountSchema);

module.exports = ChartOfAccount;
// models/ChartOfAccount.model.js
const mongoose = require('mongoose');
const { ACCOUNT_TYPES, ACCOUNT_SUBTYPES, NORMAL_BALANCE } = require('../config/constants');

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
    /**
     * Sub-grouping label used for Chart of Accounts hierarchy and dropdown
     * grouping. Optional — accounts created before this field existed will
     * have it backfilled by the migration in migrations/.
     */
    accountSubtype: {
      type: String,
      enum: [...Object.values(ACCOUNT_SUBTYPES), null],
      default: null,
      index: true,
    },
    /**
     * Numeric/text code (e.g., "1010", "4110"). Optional but recommended.
     * Unique per business when set.
     */
    accountCode: {
      type: String,
      default: null,
      trim: true,
      maxlength: 20,
    },
    /**
     * Optional parent account for hierarchical Chart of Accounts.
     * Currently unused by default seeds (subtype provides the grouping)
     * but available for future tree-style account structures.
     */
    parentAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ChartOfAccount',
      default: null,
    },
    /**
     * Control accounts (AR, AP, tax payable/receivable) summarize a subsystem
     * (invoices/bills, tax engine) and must never receive a direct manual/AI
     * posting — only the owning subsystem may post to them (it sets
     * `allowControlPosting` explicitly). See services/transaction.service.js.
     */
    isControlAccount: {
      type: Boolean,
      default: false,
      index: true,
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
      // Signed: positive when in normal-balance position, negative when contra.
      // Liabilities, equity, and contra-asset accounts can legitimately go negative.
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
// Optional unique-per-business code (partial filter ignores accounts without code)
chartOfAccountSchema.index(
  { businessId: 1, accountCode: 1 },
  { unique: true, partialFilterExpression: { accountCode: { $type: 'string' } } }
);

// ── PERFORMANCE: Additional compound indexes ───────────────────────────────
//
// Covers accountRepository.findByBusiness() sort (type + name) in one scan
chartOfAccountSchema.index(
  { businessId: 1, accountType: 1, accountName: 1 },
  { name: 'idx_coa_type_name' }
);
// Text index on accountName for fast fuzzy search in NL/Excel import resolution
chartOfAccountSchema.index(
  { accountName: 'text' },
  { name: 'idx_coa_name_text', default_language: 'none' }
);

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
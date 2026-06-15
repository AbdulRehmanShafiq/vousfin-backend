// models/Business.model.js
const mongoose = require('mongoose');
const {
  BUSINESS_TYPES, DEFAULT_CURRENCY, FISCAL_YEAR_START_MONTH_DEFAULT,
  TAX_FILING_FREQUENCIES, SUPPORTED_COUNTRIES,
} = require('../config/constants');

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
    timezone: {
      type: String,
      default: 'UTC',
      trim: true,
    },
    // Reporting currency may differ from functional currency (e.g. USD functional, PKR reporting).
    // Null means "same as currency" — resolved at query time, never stored redundantly.
    reportingCurrency: {
      type: String,
      default: null,
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

    // ── Contact / branding details (all optional, shown on invoices) ──────────
    phone: {
      type: String,
      default: null,
      trim: true,
    },
    email: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
    },
    address: {
      type: String,
      default: null,
      trim: true,
    },
    website: {
      type: String,
      default: null,
      trim: true,
    },

    // ── Phase 5.4 — Country-Aware Tax Configuration ──────────────────────────
    /**
     * taxConfig stores per-business tax settings.
     * All fields are optional with safe defaults so existing businesses
     * are completely unaffected until they explicitly enable a tax type.
     */
    taxConfig: {
      // ISO 3166-1 alpha-2 country code — drives which profile is loaded
      country: {
        type: String,
        default: 'PK',
        uppercase: true,
        trim: true,
        enum: { values: ['PK', 'AE', 'SA', 'IN', 'US', 'GB'], message: '{VALUE} is not a supported country' },
      },

      // Tax registration identifier (NTN/STRN for PK, TRN for AE/SA, GSTIN for IN, etc.)
      taxRegistrationNumber: { type: String, default: null, trim: true },

      // Feature toggles (all off by default = zero impact on existing businesses)
      gstEnabled:            { type: Boolean, default: false },  // Pakistan GST / India GST
      vatEnabled:            { type: Boolean, default: false },  // UAE/SA/GB VAT
      whtEnabled:            { type: Boolean, default: false },  // WHT / TDS
      reverseChargeEnabled:  { type: Boolean, default: false },  // AE/SA/IN reverse charge

      // Compliance flags
      registeredForTax:      { type: Boolean, default: false },
      taxInclusive:          { type: Boolean, default: true  },  // true = amounts entered include tax

      // Filing frequency — monthly | quarterly | annual
      filingFrequency: {
        type: String,
        default: 'monthly',
        enum: ['monthly', 'quarterly', 'annual'],
      },

      // Rate overrides: { 'GST': 17, 'SRB': 13 } — overrides country profile defaults
      customRates: {
        type: Map,
        of: Number,
        default: () => new Map(),
      },

      // ── FR-04.1 Autopilot ──────────────────────────────────────────────────
      // Effective income-tax rate applied to net-profit YTD for the continuous
      // income-tax provision. Default 0.29 = PK company rate; 0 disables it.
      incomeTaxProvisionRate: { type: Number, default: 0.29, min: 0, max: 0.5 },

      // When true, the live position tracks EOBI/SESSI from monthly payroll
      // accruals; otherwise those report status 'not_tracked'.
      payrollEnabled: { type: Boolean, default: false },

      // ── FR-04.3 Filing ───────────────────────────────────────────────────────
      // 'xml' = export FBR-compatible XML (always available); 'iris' = submit to
      // FBR IRIS when credentials are configured (falls back to xml on failure).
      filingMode: { type: String, enum: ['xml', 'iris'], default: 'xml' },
      // Days before a deadline to auto-prepare + validate the return (1–30).
      autoPrepareDaysBefore: { type: Number, default: 5, min: 1, max: 30 },
      // IRIS credentials — optional; only used when filingMode === 'iris'.
      fbrCredentials: {
        ntn:       { type: String, default: null },
        irisToken: { type: String, default: null },
        endpoint:  { type: String, default: null },
      },
    },

    // ── Approval Workflow (#6) ───────────────────────────────────────────────
    /**
     * approvalSettings controls whether large transactions must be reviewed
     * before they post to the ledger. All defaults mean "disabled" so existing
     * businesses are completely unaffected until they explicitly turn it on.
     */
    approvalSettings: {
      // Master switch — when false, every transaction posts immediately (legacy behaviour).
      enabled:   { type: Boolean, default: false },
      // Amounts STRICTLY GREATER than this (in base currency) require approval.
      threshold: { type: Number,  default: 0, min: 0 },
      // When false, the person who submitted a transaction cannot approve it
      // themselves (segregation of duties). Default true keeps single-user SMBs working.
      allowSelfApproval: { type: Boolean, default: true },
    },

    // ── FR-02.3 — Trend-alert thresholds ─────────────────────────────────────
    /**
     * Per-business detection thresholds for the trend monitor. Mixed so new
     * rule knobs never need a schema migration; trendMonitor.service merges
     * these over safe defaults. Empty = all defaults.
     */
    trendAlertConfig: { type: mongoose.Schema.Types.Mixed, default: {} },
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
  if (this.currency) this.currency = this.currency.toUpperCase();
  if (this.reportingCurrency) this.reportingCurrency = this.reportingCurrency.toUpperCase();
  if (this.businessName) this.businessName = this.businessName.trim();
});

// ===============================
// Model Export
// ===============================
const Business = mongoose.model('Business', businessSchema);

module.exports = Business;
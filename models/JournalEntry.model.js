// models/JournalEntry.model.js
const mongoose = require('mongoose');
const {
  TRANSACTION_TYPES,
  INPUT_METHODS,
  JOURNAL_STATUS,
  PAYMENT_STATUS,
  TRANSACTION_MODES,
  TRANSACTION_SOURCES,
  TRANSACTION_CATEGORIES,
} = require('../config/constants');

/**
 * JournalEntry Schema
 * Represents a double‑entry journal entry (affects two accounts: debit and credit).
 * Every entry must have sum(debits) = sum(credits). Here we have exactly one debit and one credit line.
 *
 * Extended in v2 to support:
 *  - Customer/Vendor references (AR/AP)
 *  - Payment tracking (due dates, partial payments, settlement)
 *  - Transaction relationships (parent/child linking)
 *  - Installment plan references
 *  - Future-compatible multi-line journal lines
 *  - Reporting classification flags
 *  - Soft delete support
 *  - Currency architecture
 *  - Transaction source tracking
 */
const journalEntrySchema = new mongoose.Schema(
  {
    // ===============================
    // Core Fields (preserved from v1)
    // ===============================
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    transactionDate: {
      type: Date,
      required: true,
      index: true,
    },
    description: {
      type: String,
      required: true,
      maxlength: 500,
      trim: true,
    },
    transactionType: {
      type: String,
      enum: Object.values(TRANSACTION_TYPES),
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    debitAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ChartOfAccount',
      required: true,
    },
    creditAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ChartOfAccount',
      required: true,
      validate: {
        validator: function (value) {
          // Ensure debit and credit accounts are different
          return this.debitAccountId.toString() !== value.toString();
        },
        message: 'Debit and credit accounts must be different',
      },
    },
    status: {
      type: String,
      enum: Object.values(JOURNAL_STATUS),
      default: JOURNAL_STATUS.POSTED,
    },
    reversalOf: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
    },
    inputMethod: {
      type: String,
      enum: Object.values(INPUT_METHODS),
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    lastModifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // ===============================
    // Transaction Mode (v2)
    // ===============================
    transactionMode: {
      type: String,
      enum: Object.values(TRANSACTION_MODES),
      default: TRANSACTION_MODES.CASH,
    },

    // ===============================
    // Party References (v2 — AR/AP)
    // ===============================
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
    },
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      default: null,
    },

    // ===============================
    // Payment Tracking (v2)
    // ===============================
    dueDate: {
      type: Date,
      default: null,
    },
    paymentStatus: {
      type: String,
      enum: [...Object.values(PAYMENT_STATUS), null],
      default: null,
    },
    remainingBalance: {
      type: Number,
      default: null,
      min: 0,
    },
    partiallyPaidAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    paymentTerms: {
      type: String,
      default: null,
      maxlength: 100,
      trim: true,
    },

    // ===============================
    // Settlement Engine (v2)
    // ===============================
    settlements: [{
      transactionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'JournalEntry',
        required: true,
      },
      amount: {
        type: Number,
        required: true,
        min: 0.01,
      },
      date: {
        type: Date,
        required: true,
      },
    }],

    // ===============================
    // Transaction Relationships (v2)
    // ===============================
    parentTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
    },
    relatedTransactions: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
    }],
    installmentPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InstallmentPlan',
      default: null,
    },

    // ===============================
    // Metadata & Classification (v2)
    // ===============================
    transactionReference: {
      type: String,
      default: null,
      trim: true,
      maxlength: 100,
    },
    invoiceNumber: {
      type: String,
      default: null,
      trim: true,
      maxlength: 50,
    },
    transactionCategory: {
      type: String,
      enum: [...Object.values(TRANSACTION_CATEGORIES), null],
      default: null,
    },
    transactionSource: {
      type: String,
      enum: Object.values(TRANSACTION_SOURCES),
      default: TRANSACTION_SOURCES.MANUAL,
    },
    notes: {
      type: String,
      default: null,
      maxlength: 1000,
      trim: true,
    },
    tags: [{
      type: String,
      trim: true,
    }],
    attachmentUrls: [{
      type: String,
    }],
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // ===============================
    // Reporting Classification (v2)
    // ===============================
    affectsCashFlow: {
      type: Boolean,
      default: true,
    },
    affectsProfitLoss: {
      type: Boolean,
      default: true,
    },
    affectsBalanceSheet: {
      type: Boolean,
      default: true,
    },

    // ===============================
    // Currency Architecture (v2 — future multi-currency ready)
    // ===============================
    currencyCode: {
      type: String,
      default: null,
      maxlength: 3,
      uppercase: true,
    },
    exchangeRate: {
      type: Number,
      default: 1,
      min: 0,
    },
    baseCurrencyAmount: {
      type: Number,
      default: null,
    },

    // ===============================
    // Soft Delete (v2)
    // ===============================
    isArchived: {
      type: Boolean,
      default: false,
    },
    archivedAt: {
      type: Date,
      default: null,
    },
    archivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // ===============================
    // Tax Fields (Phase 3.5 Step 4)
    // ===============================
    taxAmount: {
      type: Number,
      default: null,
      min: 0,
    },
    taxRate: {
      type: Number,
      default: null,
      min: 0,
      max: 100,
    },
    taxType: {
      type: String,
      default: null,
      trim: true,
      maxlength: 30,
    },
    taxInclusive: {
      type: Boolean,
      default: false,
    },

    // ===============================
    // Inventory Tracking (Phase 3.5)
    // ===============================
    inventoryItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InventoryItem',
      default: null,
    },
    inventoryQty: {
      type: Number,
      default: null,
      min: 0,
    },

    // ===============================
    // Future-Compatible Multi-Line Journal (v2 — deferred, schema only)
    // ===============================
    journalLines: [{
      accountId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ChartOfAccount',
        required: true,
      },
      type: {
        type: String,
        enum: ['debit', 'credit'],
        required: true,
      },
      amount: {
        type: Number,
        required: true,
        min: 0.01,
      },
      description: {
        type: String,
        default: '',
        maxlength: 200,
      },
    }],
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
// Indexes (optimized for reporting queries)
// ===============================

// ── Core indexes (preserved from v1) ──────────────────────────────────────
journalEntrySchema.index({ businessId: 1, transactionDate: -1, transactionType: 1 });
journalEntrySchema.index({ businessId: 1, amount: 1, transactionDate: -1 });
journalEntrySchema.index({ reversalOf: 1 });
journalEntrySchema.index({ createdBy: 1, createdAt: -1 });

// ── AR/AP indexes (v2) ────────────────────────────────────────────────────
journalEntrySchema.index({ businessId: 1, customerId: 1 });
journalEntrySchema.index({ businessId: 1, vendorId: 1 });
journalEntrySchema.index({ businessId: 1, paymentStatus: 1 });
journalEntrySchema.index({ parentTransactionId: 1 });
journalEntrySchema.index({ businessId: 1, dueDate: 1, paymentStatus: 1 });
journalEntrySchema.index({ businessId: 1, isArchived: 1, status: 1 });
journalEntrySchema.index({ installmentPlanId: 1 });

// ── PERFORMANCE: Compound indexes for the most common report queries ───────
//
// 1. Core report filter: businessId + date range + status (not archived)
//    Used by: getByDateRange, getIncomeStatementData, _getBalancesAsOf, dashboard
journalEntrySchema.index(
  { businessId: 1, transactionDate: -1, status: 1 },
  { name: 'idx_report_core' }
);

// 2. Transaction listing with archived filter — covers the default list page sort
journalEntrySchema.index(
  { businessId: 1, isArchived: 1, transactionDate: -1, status: 1 },
  { name: 'idx_listing_sorted' }
);

// 3. AR queries — outstanding receivables filtered by remaining balance
journalEntrySchema.index(
  { businessId: 1, customerId: 1, remainingBalance: 1, paymentStatus: 1 },
  { name: 'idx_ar_outstanding', sparse: true }
);

// 4. AP queries — outstanding payables filtered by remaining balance
journalEntrySchema.index(
  { businessId: 1, vendorId: 1, remainingBalance: 1, paymentStatus: 1 },
  { name: 'idx_ap_outstanding', sparse: true }
);

// 5. Account-level ledger queries — covers getByAccount() used by cash flow + ledger
journalEntrySchema.index(
  { businessId: 1, debitAccountId: 1, transactionDate: -1, status: 1 },
  { name: 'idx_ledger_debit' }
);
journalEntrySchema.index(
  { businessId: 1, creditAccountId: 1, transactionDate: -1, status: 1 },
  { name: 'idx_ledger_credit' }
);

// 5b. Tax queries
journalEntrySchema.index({ businessId: 1, taxType: 1, transactionDate: -1 },
  { sparse: true, name: 'idx_tax_type' });

// 6. Description text search — replaces slow regex scan
//    Usage: findManyWithFilters({ search: '...' })
journalEntrySchema.index(
  { description: 'text' },
  { name: 'idx_description_text', default_language: 'none' }
);

// ===============================
// Virtuals
// ===============================
journalEntrySchema.virtual('debitAccount', {
  ref: 'ChartOfAccount',
  localField: 'debitAccountId',
  foreignField: '_id',
  justOne: true,
});

journalEntrySchema.virtual('creditAccount', {
  ref: 'ChartOfAccount',
  localField: 'creditAccountId',
  foreignField: '_id',
  justOne: true,
});

journalEntrySchema.virtual('creator', {
  ref: 'User',
  localField: 'createdBy',
  foreignField: '_id',
  justOne: true,
});

journalEntrySchema.virtual('customer', {
  ref: 'Customer',
  localField: 'customerId',
  foreignField: '_id',
  justOne: true,
});

journalEntrySchema.virtual('vendor', {
  ref: 'Vendor',
  localField: 'vendorId',
  foreignField: '_id',
  justOne: true,
});

// ===============================
// Instance Methods
// ===============================

/**
 * Check if this entry is a reversal entry.
 * @returns {boolean}
 */
journalEntrySchema.methods.isReversal = function () {
  return this.status === JOURNAL_STATUS.REVERSED && this.reversalOf !== null;
};

/**
 * Check if this entry has outstanding balance.
 * @returns {boolean}
 */
journalEntrySchema.methods.hasOutstandingBalance = function () {
  return this.remainingBalance !== null && this.remainingBalance > 0;
};

/**
 * Check if this entry is fully settled.
 * @returns {boolean}
 */
journalEntrySchema.methods.isFullySettled = function () {
  return this.paymentStatus === PAYMENT_STATUS.PAID;
};

/**
 * Reverse this entry (creates a new reversal entry in the service layer).
 * This method is a placeholder; actual reversal logic resides in the service.
 * @returns {Object} - Reversal data template
 */
journalEntrySchema.methods.createReversalData = function (userId) {
  return {
    businessId: this.businessId,
    transactionDate: new Date(),
    description: `Reversal of: ${this.description}`,
    transactionType: this.transactionType,
    amount: this.amount,
    debitAccountId: this.creditAccountId, // swap debit and credit
    creditAccountId: this.debitAccountId,
    status: JOURNAL_STATUS.POSTED,
    reversalOf: this._id,
    inputMethod: this.inputMethod,
    transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
    createdBy: userId,
    lastModifiedBy: userId,
  };
};

// ===============================
// Statics
// ===============================

/**
 * Get all journal entries for a business within a date range.
 * @param {string} businessId
 * @param {Date} startDate
 * @param {Date} endDate
 * @returns {Promise<Array>}
 */
journalEntrySchema.statics.getByDateRange = function (businessId, startDate, endDate) {
  return this.find({
    businessId,
    transactionDate: { $gte: startDate, $lte: endDate },
    status: { $in: [JOURNAL_STATUS.POSTED, JOURNAL_STATUS.PARTIALLY_SETTLED, JOURNAL_STATUS.SETTLED] },
    isArchived: { $ne: true },
  }).sort('transactionDate');
};

/**
 * Get total debits or credits for a specific account within a date range.
 * Used in ledger reports.
 * @param {string} businessId
 * @param {string} accountId
 * @param {Date} startDate
 * @param {Date} endDate
 * @param {string} side - 'debit' or 'credit'
 * @returns {Promise<number>}
 */
journalEntrySchema.statics.getAccountTurnover = async function (businessId, accountId, startDate, endDate, side) {
  const matchField = side === 'debit' ? 'debitAccountId' : 'creditAccountId';
  const result = await this.aggregate([
    {
      $match: {
        businessId,
        status: { $in: [JOURNAL_STATUS.POSTED, JOURNAL_STATUS.PARTIALLY_SETTLED, JOURNAL_STATUS.SETTLED] },
        isArchived: { $ne: true },
        transactionDate: { $gte: startDate, $lte: endDate },
        [matchField]: accountId,
      },
    },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return result.length ? result[0].total : 0;
};

// ===============================
// Pre-save Middleware
// ===============================
journalEntrySchema.pre('save', function () {
  if (this.description) {
    this.description = this.description.trim();
  }
  if (this.isNew && !this.lastModifiedBy) {
    this.lastModifiedBy = this.createdBy;
  }
  // Auto-set baseCurrencyAmount if not provided
  if (this.isNew && this.baseCurrencyAmount === null) {
    this.baseCurrencyAmount = this.amount * (this.exchangeRate || 1);
  }

  // ── Invariant: keep paymentStatus and JournalStatus consistent with remainingBalance ──
  // Only applies to AR/AP/installment entries (those that track remainingBalance).
  // Cash-side entries have remainingBalance === null and should not be touched.
  if (this.remainingBalance !== null && this.remainingBalance !== undefined) {
    if (this.remainingBalance <= 0) {
      // Fully settled — force status invariants
      this.paymentStatus = PAYMENT_STATUS.PAID;
      if (this.status !== JOURNAL_STATUS.REVERSED) {
        this.status = JOURNAL_STATUS.SETTLED;
      }
      this.remainingBalance = 0;  // normalise: never store negative
    } else if (this.partiallyPaidAmount > 0) {
      // Some payment received but not fully settled
      this.paymentStatus = PAYMENT_STATUS.PARTIALLY_PAID;
      if (this.status === JOURNAL_STATUS.POSTED) {
        this.status = JOURNAL_STATUS.PARTIALLY_SETTLED;
      }
    } else if (this.dueDate && new Date() > new Date(this.dueDate)) {
      // Overdue (no payment, past due date)
      this.paymentStatus = PAYMENT_STATUS.OVERDUE;
    } else {
      // Unpaid, not overdue, no partial payments
      if (!this.paymentStatus) this.paymentStatus = PAYMENT_STATUS.UNPAID;
    }
  }
});

// ===============================
// Model Export
// ===============================
const JournalEntry = mongoose.model('JournalEntry', journalEntrySchema);

module.exports = JournalEntry;
// models/Customer.model.js
const mongoose = require('mongoose');

/**
 * Customer Schema
 * Lightweight customer/debtor tracking for Accounts Receivable.
 * Linked to JournalEntry via customerId for credit sales and payment tracking.
 */
const customerSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    fullName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    businessName: {
      type: String,
      default: null,
      trim: true,
      maxlength: 150,
    },
    phone: {
      type: String,
      default: null,
      trim: true,
      maxlength: 20,
    },
    email: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
      maxlength: 100,
    },
    address: {
      type: String,
      default: null,
      trim: true,
      maxlength: 300,
    },
    creditLimit: {
      type: Number,
      default: null,
      min: 0,
    },
    creditLimitAction: {
      type: String,
      enum: ['warn', 'block'],
      default: 'warn',
    },
    currentReceivableBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    taxId: {
      type: String,
      default: null,
      trim: true,
      maxlength: 50,
    },
    paymentTerms: {
      type: String,
      default: null,
      trim: true,
      maxlength: 100,
    },
    notes: {
      type: String,
      default: null,
      trim: true,
      maxlength: 500,
    },
    isActive: {
      type: Boolean,
      default: true,
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
customerSchema.index({ businessId: 1, isActive: 1 });
// $type rather than `$ne: null`: mongod refuses a negation in a partial index,
// so the $ne form never built and duplicate customer emails were never actually
// prevented. `$type: 'string'` selects exactly the same documents (a real email)
// and is accepted.
customerSchema.index({ businessId: 1, email: 1 }, {
  unique: true,
  partialFilterExpression: { email: { $type: 'string' } },
});
customerSchema.index({ businessId: 1, fullName: 1 });
customerSchema.index({ businessId: 1, currentReceivableBalance: -1 });

// ===============================
// Instance Methods
// ===============================

/**
 * Update receivable balance by a delta amount.
 * @param {number} delta - Positive to increase, negative to decrease
 * @returns {Promise<Customer>}
 */
customerSchema.methods.updateBalance = async function (delta) {
  this.currentReceivableBalance = Math.max(0, this.currentReceivableBalance + delta);
  await this.save();
  return this;
};

// ===============================
// Statics
// ===============================

/**
 * Get top debtors (customers with highest outstanding receivables).
 * @param {string} businessId
 * @param {number} limit
 * @returns {Promise<Array>}
 */
customerSchema.statics.getTopDebtors = function (businessId, limit = 10) {
  return this.find({
    businessId,
    isActive: true,
    currentReceivableBalance: { $gt: 0 },
  })
    .sort({ currentReceivableBalance: -1 })
    .limit(limit)
    .lean();
};

// ===============================
// Pre-save Middleware
// ===============================
customerSchema.pre('save', function () {
  if (this.fullName) {
    this.fullName = this.fullName.trim();
  }
});

// ===============================
// Model Export
// ===============================
const Customer = mongoose.model('Customer', customerSchema);

module.exports = Customer;

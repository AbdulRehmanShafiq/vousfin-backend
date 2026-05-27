// models/Vendor.model.js
const mongoose = require('mongoose');

/**
 * Vendor Schema
 * Lightweight vendor/creditor tracking for Accounts Payable.
 * Linked to JournalEntry via vendorId for credit purchases and payment tracking.
 */
const vendorSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    vendorName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
    },
    contactPerson: {
      type: String,
      default: null,
      trim: true,
      maxlength: 100,
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
    currentPayableBalance: {
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

    // ── Phase 5.4.4 — WHT Profile ────────────────────────────────────────────
    /**
     * Withholding Tax profile for this vendor.
     * When enabled, every payment to this vendor auto-deducts WHT at source.
     */
    whtProfile: {
      enabled:     { type: Boolean, default: false },
      // WHT schedule category — maps to country profile whtSchedules[].category
      // Pakistan examples: 'services_company' | 'services_individual' | 'goods_company' | 'rent_filer'
      // India examples: 'tds_contractor' | 'tds_professional' | 'tds_rent'
      category:    { type: String, default: null, trim: true },
      // Is vendor a non-filer? (Pakistan: higher rates for non-filers)
      isNonFiler:  { type: Boolean, default: false },
      // Optional rate override (beats schedule default)
      customRate:  { type: Number, default: null, min: 0, max: 100 },
      // Vendor's STRN (Sales Tax Registration Number) — for Pakistan WHT receipts
      strn:        { type: String, default: null, trim: true, maxlength: 30 },
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
vendorSchema.index({ businessId: 1, isActive: 1 });
vendorSchema.index({ businessId: 1, email: 1 }, {
  unique: true,
  partialFilterExpression: { email: { $ne: null } },
});
vendorSchema.index({ businessId: 1, vendorName: 1 });
vendorSchema.index({ businessId: 1, currentPayableBalance: -1 });

// ===============================
// Instance Methods
// ===============================

/**
 * Update payable balance by a delta amount.
 * @param {number} delta - Positive to increase, negative to decrease
 * @returns {Promise<Vendor>}
 */
vendorSchema.methods.updateBalance = async function (delta) {
  this.currentPayableBalance = Math.max(0, this.currentPayableBalance + delta);
  await this.save();
  return this;
};

// ===============================
// Statics
// ===============================

/**
 * Get top creditors (vendors with highest outstanding payables).
 * @param {string} businessId
 * @param {number} limit
 * @returns {Promise<Array>}
 */
vendorSchema.statics.getTopCreditors = function (businessId, limit = 10) {
  return this.find({
    businessId,
    isActive: true,
    currentPayableBalance: { $gt: 0 },
  })
    .sort({ currentPayableBalance: -1 })
    .limit(limit)
    .lean();
};

// ===============================
// Pre-save Middleware
// ===============================
vendorSchema.pre('save', function () {
  if (this.vendorName) {
    this.vendorName = this.vendorName.trim();
  }
});

// ===============================
// Model Export
// ===============================
const Vendor = mongoose.model('Vendor', vendorSchema);

module.exports = Vendor;

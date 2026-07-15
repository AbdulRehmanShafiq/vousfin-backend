// models/VendorCredit.model.js
//
// Phase 3.1 — Vendor Credit entity.
//
// Represents money owed TO US by a vendor (their credit against our AP balance).
// Common cases:
//   - Vendor issues a credit note for returned/defective goods
//   - We overpaid a vendor and they acknowledge the credit
//   - Price adjustment after delivery
//
// A vendor credit reduces the outstanding AP balance when applied to a Bill.
//
const mongoose = require('mongoose');
const { VENDOR_CREDIT_STATES } = require('../config/constants');

// ── Sub-schemas ───────────────────────────────────────────────────────────────

const applicationSchema = new mongoose.Schema(
  {
    billId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Bill', required: true },
    billNumber:    { type: String, required: true, maxlength: 50 },
    appliedAmount: { type: Number, required: true, min: 0.01 },
    appliedAt:     { type: Date, default: Date.now },
    appliedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    notes:         { type: String, default: null, maxlength: 300 },
  },
  { _id: true }
);

// ── Main schema ───────────────────────────────────────────────────────────────

const vendorCreditSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },

    creditNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
      index: true,
    },

    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
      index: true,
    },

    // The bill this credit originated from (e.g., returned goods bill)
    sourceBillId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Bill',
      default: null,
    },

    // The GRN that triggered the credit (e.g., discrepancy resulted in credit)
    sourceGrnId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'GoodsReceipt',
      default: null,
    },

    state: {
      type: String,
      enum: Object.values(VENDOR_CREDIT_STATES),
      default: VENDOR_CREDIT_STATES.OPEN,
      index: true,
    },

    creditDate:       { type: Date, required: true, index: true },
    currencyCode:     { type: String, default: 'PKR', uppercase: true, maxlength: 3 },
    exchangeRate:     { type: Number, default: 1, min: 0 },
    amount:           { type: Number, required: true, min: 0.01 },
    remainingAmount:  { type: Number, default: null, min: 0 }, // amount - total applied

    reason: {
      type: String,
      required: true,
      enum: [
        'goods_returned',
        'defective_goods',
        'price_adjustment',
        'overpayment',
        'duplicate_invoice',
        'quantity_shortage',
        'quality_rejection',
        'other',
      ],
    },
    reasonDescription: { type: String, default: null, maxlength: 500, trim: true },

    // Track every partial application against bills
    appliedTransactions: { type: [applicationSchema], default: [] },

    // Inventory Engine Phase 3 — physical goods being returned to the vendor.
    // When present, creating the credit takes the stock OUT and posts
    // DR Vendor Credit Clearing (1156) / CR Inventory (cost) ± the price
    // difference; applications then clear 1156 instead of booking income.
    returnItems: {
      type: [
        {
          _id: false,
          inventoryItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
          quantity: { type: Number, required: true, min: 0.0001 },
          /** Cost each unit left stock at (set at creation; used to restock on cancel). */
          unitCostAtReturn: { type: Number, default: null, min: 0 },
        },
      ],
      default: [],
    },
    // The compound journal posted at creation for the inventory leg.
    inventoryJournalId: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },

    notes:    { type: String, default: null, maxlength: 1000, trim: true },
    tags:     [{ type: String, trim: true }],

    createdBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    lastModifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isArchived:     { type: Boolean, default: false, index: true },
    archivedAt:     { type: Date, default: null },
    archivedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => { delete ret.__v; return ret; },
    },
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
vendorCreditSchema.index({ businessId: 1, creditNumber: 1 }, { unique: true, sparse: true });
vendorCreditSchema.index({ businessId: 1, vendorId: 1, state: 1 });
vendorCreditSchema.index({ businessId: 1, state: 1, creditDate: -1 });
vendorCreditSchema.index({ businessId: 1, remainingAmount: -1, state: 1 });

// ── Pre-save: initialise remainingAmount on creation ─────────────────────────

vendorCreditSchema.pre('save', function () {
  if (this.isNew && (this.remainingAmount === null || this.remainingAmount === undefined)) {
    this.remainingAmount = this.amount;
  }
  // Recompute state from applications
  const totalApplied = (this.appliedTransactions || [])
    .reduce((s, a) => s + a.appliedAmount, 0);
  this.remainingAmount = Math.max(0, Math.round((this.amount - totalApplied) * 100) / 100);
  if (this.remainingAmount <= 0) {
    this.state = VENDOR_CREDIT_STATES.FULLY_APPLIED;
  } else if (totalApplied > 0 && this.remainingAmount > 0) {
    if (this.state !== VENDOR_CREDIT_STATES.CANCELLED) {
      this.state = VENDOR_CREDIT_STATES.PARTIALLY_APPLIED;
    }
  }
});

const VendorCredit = mongoose.model('VendorCredit', vendorCreditSchema);
module.exports = VendorCredit;

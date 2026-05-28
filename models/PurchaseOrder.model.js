// models/PurchaseOrder.model.js
//
// Phase 3.1 — Purchase Order (PO) domain entity.
//
// A PO is the commitment document that precedes receiving and billing.
// Lifecycle: draft → pending_approval → approved → partially_received /
//            fully_received → billed → closed.
//
// 3-Way Match: PO ↔ GoodsReceipt ↔ Bill must reconcile before payment.
//
const mongoose = require('mongoose');
const {
  PO_STATES,
  PO_TRANSITIONS,
  APPROVAL_STATUS,
  APPROVER_ROLES,
  DEFAULT_APPROVAL_THRESHOLD,
} = require('../config/constants');

// ── Sub-schemas ───────────────────────────────────────────────────────────────

const poLineItemSchema = new mongoose.Schema(
  {
    inventoryItemId:  { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', default: null },
    itemType:         { type: String, enum: ['product', 'service', 'custom'], default: 'custom' },
    sku:              { type: String, default: null, trim: true, maxlength: 100 },
    name:             { type: String, required: true, trim: true, maxlength: 300 },
    description:      { type: String, default: null, trim: true, maxlength: 500 },
    unit:             { type: String, default: 'pcs', trim: true, maxlength: 20 },
    quantityOrdered:  { type: Number, required: true, min: 0.0001 },
    quantityReceived: { type: Number, default: 0, min: 0 },     // updated by GRN
    unitPrice:        { type: Number, required: true, min: 0 },
    discountType:     { type: String, enum: ['percentage', 'fixed', null], default: null },
    discountValue:    { type: Number, default: 0, min: 0 },
    discountAmount:   { type: Number, default: 0, min: 0 },     // computed
    taxRate:          { type: Number, default: 0, min: 0, max: 100 },
    taxAmount:        { type: Number, default: 0, min: 0 },     // computed
    lineTotal:        { type: Number, default: 0, min: 0 },     // computed
    accountId:        { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    sortOrder:        { type: Number, default: 0 },
  },
  { _id: true }
);

const approvalLogEntrySchema = new mongoose.Schema(
  {
    action:    { type: String, enum: ['submitted', 'approved', 'rejected'], required: true },
    actorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actorName: { type: String, required: true },
    actorRole: { type: String, enum: Object.values(APPROVER_ROLES), default: null },
    note:      { type: String, default: null, maxlength: 500 },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const stateChangeSchema = new mongoose.Schema(
  {
    fromState: { type: String, required: true },
    toState:   { type: String, required: true },
    actorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actorName: { type: String, required: true },
    reason:    { type: String, default: null, maxlength: 500 },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

// ── Main schema ───────────────────────────────────────────────────────────────

const purchaseOrderSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },

    poNumber: {
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
    },

    // Snapshot of vendor at PO creation time — immutable audit record
    vendorSnapshot: {
      vendorName: { type: String, default: null },
      email:      { type: String, default: null },
      phone:      { type: String, default: null },
      taxId:      { type: String, default: null },
    },

    currencyCode: { type: String, default: 'PKR', uppercase: true, maxlength: 3 },
    exchangeRate: { type: Number, default: 1, min: 0 },

    // ── State Machine ─────────────────────────────────────────────────────────
    state: {
      type: String,
      enum: Object.values(PO_STATES),
      default: PO_STATES.DRAFT,
      index: true,
    },
    stateHistory: [stateChangeSchema],

    // ── Approval Workflow ─────────────────────────────────────────────────────
    approvalRequired:  { type: Boolean, default: false },
    approvalStatus: {
      type: String,
      enum: Object.values(APPROVAL_STATUS),
      default: APPROVAL_STATUS.NOT_REQUIRED,
    },
    approvalThreshold: { type: Number, default: null },
    approvalLog: [approvalLogEntrySchema],
    approvedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt:  { type: Date, default: null },

    // ── Line Items ────────────────────────────────────────────────────────────
    lineItems: {
      type: [poLineItemSchema],
      default: [],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message:   'A purchase order must have at least one line item.',
      },
    },

    // ── Computed Totals ───────────────────────────────────────────────────────
    subtotal:              { type: Number, default: 0, min: 0 },
    totalLineDiscount:     { type: Number, default: 0, min: 0 },
    invoiceDiscountType:   { type: String, enum: ['percentage', 'fixed', null], default: null },
    invoiceDiscountValue:  { type: Number, default: 0, min: 0 },
    invoiceDiscountAmount: { type: Number, default: 0, min: 0 },
    totalTax:              { type: Number, default: 0, min: 0 },
    shippingCharges:       { type: Number, default: 0, min: 0 },
    roundingAdjustment:    { type: Number, default: 0 },
    totalAmount:           { type: Number, default: 0, min: 0 }, // grand total
    baseCurrencyTotal:     { type: Number, default: null },

    // ── Dates ─────────────────────────────────────────────────────────────────
    issueDate:             { type: Date, required: true, index: true },
    expectedDeliveryDate:  { type: Date, default: null, index: true },

    // ── Cross-document Links (3-Way Match) ────────────────────────────────────
    linkedGrnIds:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'GoodsReceipt' }],
    linkedBillIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Bill' }],

    // ── Terms, Notes ──────────────────────────────────────────────────────────
    paymentTerms: { type: String, default: null, maxlength: 200, trim: true },
    notes:        { type: String, default: null, maxlength: 1000, trim: true },
    tags:         [{ type: String, trim: true }],

    // ── Metadata ──────────────────────────────────────────────────────────────
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
// Unique PO number per business
purchaseOrderSchema.index({ businessId: 1, poNumber: 1 }, { unique: true, sparse: true });
// Common AP queries
purchaseOrderSchema.index({ businessId: 1, state: 1, issueDate: -1 });
purchaseOrderSchema.index({ businessId: 1, vendorId: 1, state: 1 });
purchaseOrderSchema.index({ businessId: 1, approvalStatus: 1, state: 1 });
purchaseOrderSchema.index({ businessId: 1, expectedDeliveryDate: 1, state: 1 });
purchaseOrderSchema.index({ businessId: 1, isArchived: 1, createdAt: -1 });

// ── Statics ───────────────────────────────────────────────────────────────────

purchaseOrderSchema.statics.canTransition = function (fromState, toState) {
  if (fromState === toState) return true;
  const allowed = PO_TRANSITIONS[fromState];
  return Array.isArray(allowed) && allowed.includes(toState);
};

// ── Instance Methods ──────────────────────────────────────────────────────────

purchaseOrderSchema.methods.recordStateChange = function (toState, actor, reason = null) {
  this.stateHistory.push({
    fromState: this.state,
    toState,
    actorId:   actor._id,
    actorName: actor.fullName || actor.email || 'Unknown',
    reason,
    timestamp: new Date(),
  });
};

// ── Pre-save: compute totals from line items ──────────────────────────────────

purchaseOrderSchema.pre('save', function () {
  const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  if (!this.lineItems || this.lineItems.length === 0) return;

  let subtotal = 0, totalLineDiscount = 0, totalTax = 0;

  for (const li of this.lineItems) {
    const gross = r2(li.quantityOrdered * li.unitPrice);
    let disc = 0;
    if (li.discountType === 'percentage' && li.discountValue > 0) {
      disc = r2(gross * li.discountValue / 100);
    } else if (li.discountType === 'fixed' && li.discountValue > 0) {
      disc = r2(Math.min(li.discountValue, gross));
    }
    li.discountAmount = disc;
    totalLineDiscount += disc;

    const afterDiscount = gross - disc;
    const tax = li.taxRate > 0 ? r2(afterDiscount * li.taxRate / 100) : 0;
    li.taxAmount = tax;
    totalTax += tax;
    li.lineTotal = r2(afterDiscount + tax);
    subtotal += gross;
  }

  this.subtotal = r2(subtotal);
  this.totalLineDiscount = r2(totalLineDiscount);
  this.totalTax = r2(totalTax);

  const afterLineDiscounts = r2(subtotal - totalLineDiscount);
  let invoiceDisc = 0;
  if (this.invoiceDiscountType === 'percentage' && this.invoiceDiscountValue > 0) {
    invoiceDisc = r2(afterLineDiscounts * this.invoiceDiscountValue / 100);
  } else if (this.invoiceDiscountType === 'fixed' && this.invoiceDiscountValue > 0) {
    invoiceDisc = r2(Math.min(this.invoiceDiscountValue, afterLineDiscounts));
  }
  this.invoiceDiscountAmount = invoiceDisc;

  const netBeforeTax = r2(afterLineDiscounts - invoiceDisc);
  this.totalAmount = r2(netBeforeTax + totalTax + (this.shippingCharges || 0) + (this.roundingAdjustment || 0));

  if (this.exchangeRate && this.exchangeRate !== 1) {
    this.baseCurrencyTotal = r2(this.totalAmount * this.exchangeRate);
  } else {
    this.baseCurrencyTotal = this.totalAmount;
  }
});

const PurchaseOrder = mongoose.model('PurchaseOrder', purchaseOrderSchema);
module.exports = PurchaseOrder;

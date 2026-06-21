// models/GoodsReceipt.model.js
//
// Phase 3.1 — Goods Receipt Note (GRN) entity.
//
// Records what was physically received against a Purchase Order.
// A single PO can have multiple GRNs (partial deliveries).
// Used as the second leg of the 3-way match: PO → GRN → Bill.
//
const mongoose = require('mongoose');
const { GRN_STATES, GRN_TRANSITIONS } = require('../config/constants');

// ── Sub-schemas ───────────────────────────────────────────────────────────────

const receivedItemSchema = new mongoose.Schema(
  {
    poLineItemId:     { type: mongoose.Schema.Types.ObjectId, required: true }, // _id of PO line
    inventoryItemId:  { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', default: null },
    sku:              { type: String, default: null, trim: true, maxlength: 100 },
    name:             { type: String, required: true, trim: true, maxlength: 300 },
    unit:             { type: String, default: 'pcs', trim: true, maxlength: 20 },
    quantityOrdered:  { type: Number, required: true, min: 0 },
    quantityReceived: { type: Number, required: true, min: 0 },
    // Damage/shortage tracking
    quantityRejected: { type: Number, default: 0, min: 0 },
    unitCost:         { type: Number, required: true, min: 0 },
    lineTotal:        { type: Number, default: 0, min: 0 }, // quantityReceived × unitCost
    batchNumber:      { type: String, default: null, trim: true, maxlength: 50 },
    expiryDate:       { type: Date, default: null },
    notes:            { type: String, default: null, maxlength: 300 },
  },
  { _id: true }
);

const discrepancySchema = new mongoose.Schema(
  {
    poLineItemId:     { type: mongoose.Schema.Types.ObjectId, required: true },
    type:             {
      type: String,
      enum: ['quantity_short', 'quantity_excess', 'quality_reject', 'wrong_item', 'price_mismatch'],
      required: true,
    },
    description:      { type: String, required: true, maxlength: 500 },
    quantityExpected: { type: Number, default: null },
    quantityActual:   { type: Number, default: null },
    priceExpected:    { type: Number, default: null },
    priceActual:      { type: Number, default: null },
    resolution:       {
      type: String,
      enum: ['pending', 'accepted', 'returned_to_vendor', 'credit_note_raised', 'waived'],
      default: 'pending',
    },
    resolvedAt:       { type: Date, default: null },
    resolvedBy:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    notes:            { type: String, default: null, maxlength: 500 },
  },
  { _id: true }
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

const goodsReceiptSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },

    grnNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
      index: true,
    },

    purchaseOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PurchaseOrder',
      required: true,
      index: true,
    },

    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
    },

    // ── State Machine ─────────────────────────────────────────────────────────
    state: {
      type: String,
      enum: Object.values(GRN_STATES),
      default: GRN_STATES.DRAFT,
      index: true,
    },
    stateHistory: [stateChangeSchema],

    // ── Receiving Data ────────────────────────────────────────────────────────
    receivedDate:    { type: Date, required: true, index: true },
    receivedItems:   { type: [receivedItemSchema], default: [] },
    discrepancies:   { type: [discrepancySchema], default: [] },

    // ── Location / Logistics ──────────────────────────────────────────────────
    warehouse:         { type: String, default: null, trim: true, maxlength: 100 },
    receivedByName:    { type: String, default: null, trim: true, maxlength: 100 },
    deliveryNoteNumber:{ type: String, default: null, trim: true, maxlength: 50 },
    vehicleNumber:     { type: String, default: null, trim: true, maxlength: 30 },

    // ── Cross-document Links ──────────────────────────────────────────────────
    linkedBillIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Bill' }],

    // ── Computed Totals ───────────────────────────────────────────────────────
    totalReceivedValue: { type: Number, default: 0, min: 0 }, // sum(receivedItems.lineTotal)

    // ── Flags ─────────────────────────────────────────────────────────────────
    hasDiscrepancies:  { type: Boolean, default: false, index: true },
    isFullyReceived:   { type: Boolean, default: false, index: true },

    // ERP Step 5 — set once the received goods have been added to inventory
    // (weighted-average cost). Guards against double-incrementing stock if the
    // confirm path is ever re-run. See goodsReceipt.service._applyReceivedStock.
    inventoryApplied:   { type: Boolean, default: false },
    inventoryAppliedAt: { type: Date, default: null },

    // A13 — the GRNI accrual journal posted on confirm (DR Inventory 1150 /
    // CR Goods Received Not Invoiced 2115). Set once, alongside inventoryApplied,
    // so a retry after a crash converges instead of double-posting.
    glJournalId: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },

    // ── Metadata ──────────────────────────────────────────────────────────────
    notes:          { type: String, default: null, maxlength: 1000, trim: true },
    createdBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    lastModifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isArchived:     { type: Boolean, default: false, index: true },
    archivedAt:     { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => { delete ret.__v; return ret; },
    },
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
goodsReceiptSchema.index({ businessId: 1, grnNumber: 1 }, { unique: true, sparse: true });
goodsReceiptSchema.index({ businessId: 1, state: 1, receivedDate: -1 });
goodsReceiptSchema.index({ businessId: 1, vendorId: 1, state: 1 });
goodsReceiptSchema.index({ purchaseOrderId: 1, state: 1 });
goodsReceiptSchema.index({ businessId: 1, hasDiscrepancies: 1, state: 1 });

// ── Statics ───────────────────────────────────────────────────────────────────

goodsReceiptSchema.statics.canTransition = function (fromState, toState) {
  if (fromState === toState) return true;
  const allowed = GRN_TRANSITIONS[fromState];
  return Array.isArray(allowed) && allowed.includes(toState);
};

// ── Instance Methods ──────────────────────────────────────────────────────────

goodsReceiptSchema.methods.recordStateChange = function (toState, actor, reason = null) {
  this.stateHistory.push({
    fromState: this.state,
    toState,
    actorId:   actor._id,
    actorName: actor.fullName || actor.email || 'Unknown',
    reason,
    timestamp: new Date(),
  });
};

// ── Pre-save: compute totals + flags ──────────────────────────────────────────

goodsReceiptSchema.pre('save', function () {
  const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

  let total = 0;
  for (const item of (this.receivedItems || [])) {
    item.lineTotal = r2(item.quantityReceived * item.unitCost);
    total += item.lineTotal;
  }
  this.totalReceivedValue = r2(total);

  this.hasDiscrepancies = (this.discrepancies || []).length > 0;
});

const GoodsReceipt = mongoose.model('GoodsReceipt', goodsReceiptSchema);
module.exports = GoodsReceipt;

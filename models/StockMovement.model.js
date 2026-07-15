// models/StockMovement.model.js
//
// Inventory Engine Phase 1 — the item sub-ledger (Dynamics NAV "Item Ledger
// Entry" pattern; see docs/superpowers/specs/2026-07-15-enterprise-inventory-engine.md).
//
// APPEND-ONLY: one document per physical stock movement, written in the SAME
// mongo session as the item mutation and the journal entry. Movements are
// never updated or deleted — corrections are new movements, exactly like
// journal entries. The item's currentStock / unitCostPrice / costLayers are
// cached projections rebuildable from this collection.
'use strict';

const mongoose = require('mongoose');

const MOVEMENT_TYPES = [
  'opening',           // seeded opening balance — stock that predates the sub-ledger.
                       // Carries NO journal: the GL already booked it when it was bought.
  'purchase',          // goods received (GRN confirm, direct purchase, add-stock)
  'sale',              // goods sold (invoice approval, direct sale transaction)
  'sale_return',       // customer returned goods → back into stock
  'purchase_return',   // goods returned to a vendor → out of stock
  'receipt_reversal',  // a receipt undone (GRN cancel) at its receipt cost
  'sale_reversal',     // a sale undone (transaction reversal) → back into stock
  'adjustment_in',     // manual increase (found stock, correction)
  'adjustment_out',    // manual decrease (shrinkage, damage)
  'write_off',         // stock written off (damaged/expired/lost)
  'count',             // physical count variance posting
  'revalue',           // value-only cost revaluation (NRV write-down etc.) — qty 0
  'transfer_in',       // warehouse transfer arrival   (Phase 5)
  'transfer_out',      // warehouse transfer dispatch  (Phase 5)
  'assembly_in',       // manufacturing output         (Phase 9)
  'assembly_out',      // component consumption        (Phase 9)
];

const stockMovementSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InventoryItem',
      required: true,
      index: true,
    },
    /** Physical direction of the movement. */
    direction: { type: String, enum: ['in', 'out'], required: true },
    /** Business meaning — every type maps to one fixed JE recipe (spec §2.3). */
    movementType: { type: String, enum: MOVEMENT_TYPES, required: true },
    /** Units moved — positive; direction carries the sign. Revaluations are
     *  value-only events and carry qty 0 (Σqty untouched, Σvalue adjusted). */
    qty: { type: Number, required: true, min: 0 },
    /** Cost per unit this movement was valued at (receipt cost / COGS unit cost). */
    unitCost: { type: Number, required: true, min: 0 },
    /** qty × unitCost, rounded to cents — the exact GL impact of this movement. */
    value: { type: Number, required: true, min: 0 },
    /** Item balance snapshots AFTER this movement (projection audit anchors). */
    balanceQtyAfter: { type: Number, required: true, min: 0 },
    balanceValueAfter: { type: Number, required: true, min: 0 },
    /** The document that caused this movement (GRN, Invoice, CreditNote, JE…). */
    source: {
      docType: { type: String, default: null, trim: true, maxlength: 40 },
      docId: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    /** The journal entry carrying this movement's GL effect (when posted). */
    journalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
    },
    /** Warehouse — null until Phase 5 introduces multi-warehouse. */
    warehouseId: { type: mongoose.Schema.Types.ObjectId, default: null },
    movementDate: { type: Date, required: true, default: Date.now },
    /** Structured reason code (adjustments/write-offs/NRV) — plain notes below. */
    reason: { type: String, default: null, trim: true, maxlength: 60 },
    notes: { type: String, default: null, trim: true, maxlength: 500 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      transform: (doc, ret) => { delete ret.__v; return ret; },
    },
  }
);

stockMovementSchema.index({ businessId: 1, itemId: 1, movementDate: 1, _id: 1 });
stockMovementSchema.index({ businessId: 1, movementType: 1, movementDate: -1 });
stockMovementSchema.index({ businessId: 1, 'source.docType': 1, 'source.docId': 1 });

// ── Append-only enforcement ──────────────────────────────────────────────────
// Financial history is permanent (CLAUDE.md). Corrections are new movements.
const APPEND_ONLY_MSG = 'StockMovement is append-only — post a correcting movement instead';
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne']) {
  stockMovementSchema.pre(op, function () { throw new Error(APPEND_ONLY_MSG); });
}
for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete']) {
  stockMovementSchema.pre(op, { document: false, query: true }, function () { throw new Error(APPEND_ONLY_MSG); });
}
// Promise-style (zero-arity) to match the hooks above — a `next` callback is
// not passed here, and asking for one silently breaks every insert.
stockMovementSchema.pre('save', function () {
  if (!this.isNew) throw new Error(APPEND_ONLY_MSG);
});

const StockMovement = mongoose.model('StockMovement', stockMovementSchema);
StockMovement.MOVEMENT_TYPES = MOVEMENT_TYPES;
module.exports = StockMovement;

// models/Warehouse.model.js
//
// Inventory Engine Phase 5 — a stock location (warehouse, shop, van, bin).
//
// Warehouses are a DIMENSION of the stock sub-ledger, not a second source of
// truth: per-location balances are derived from StockMovement.warehouseId, so
// they can never disagree with the item's total or with the general ledger.
// Moving stock between locations changes no value and posts no journal.
'use strict';

const mongoose = require('mongoose');

const warehouseSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    code: { type: String, default: null, trim: true, maxlength: 20, uppercase: true },
    address: { type: String, default: null, trim: true, maxlength: 300 },
    /** Where stock lands when a movement names no warehouse. Exactly one per tenant. */
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    notes: { type: String, default: null, trim: true, maxlength: 500 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    toJSON: { transform: (doc, ret) => { delete ret.__v; return ret; } },
  }
);

warehouseSchema.index({ businessId: 1, isActive: 1 });
warehouseSchema.index({ businessId: 1, code: 1 }, {
  unique: true,
  partialFilterExpression: { code: { $type: 'string' } },
});

module.exports = mongoose.model('Warehouse', warehouseSchema);

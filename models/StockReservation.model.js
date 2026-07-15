// models/StockReservation.model.js
//
// Inventory Engine Phase 6 — a promise of stock, not a movement of it.
//
// Reserving carries NO accounting effect: the goods are still ours, still on
// the shelf, still in Inventory at cost. Only fulfilment (shipping) moves
// stock and posts COGS. This model exists purely so Available-to-Promise can
// answer "what can I actually sell?" = on hand − reserved.
'use strict';

const mongoose = require('mongoose');

const RESERVATION_STATES = ['active', 'fulfilled', 'released', 'backordered'];

const stockReservationSchema = new mongoose.Schema(
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
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null },
    /** Units promised. For a backorder this is the shortfall we could NOT promise. */
    qty: { type: Number, required: true, min: 0.000001 },
    state: { type: String, enum: RESERVATION_STATES, default: 'active', index: true },
    /** What promised it — an invoice draft, a sales order, a job. */
    source: {
      docType: { type: String, default: null, trim: true, maxlength: 40 },
      docId: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    expectedDate: { type: Date, default: null },
    fulfilledAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
    notes: { type: String, default: null, trim: true, maxlength: 300 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    toJSON: { transform: (doc, ret) => { delete ret.__v; return ret; } },
  }
);

stockReservationSchema.index({ businessId: 1, itemId: 1, state: 1 });
stockReservationSchema.index({ businessId: 1, 'source.docType': 1, 'source.docId': 1 });

const StockReservation = mongoose.model('StockReservation', stockReservationSchema);
StockReservation.RESERVATION_STATES = RESERVATION_STATES;
module.exports = StockReservation;

// models/InventoryItem.model.js
const mongoose = require('mongoose');

/**
 * InventoryItem Schema
 * Tracks stock items with weighted-average cost pricing.
 * When an Inventory Sale is recorded with an inventoryItemId, the transaction
 * service auto-generates a COGS journal line using the item's unitCostPrice.
 */
const inventoryItemSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    sku: {
      type: String,
      default: null,
      trim: true,
      maxlength: 100,
    },
    description: {
      type: String,
      default: null,
      trim: true,
      maxlength: 500,
    },
    unitCostPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    unitSalePrice: {
      type: Number,
      default: null,
      min: 0,
    },
    currentStock: {
      type: Number,
      default: 0,
      min: 0,
    },
    reorderLevel: {
      type: Number,
      default: 0,
      min: 0,
    },
    reorderQty: {
      type: Number,
      default: 0,
      min: 0,
    },
    unit: {
      type: String,
      default: 'units',
      trim: true,
      maxlength: 30,
    },
    // Phase 5.5 Step 4 — enriched item catalog fields
    barcode: {
      type: String,
      default: null,
      trim: true,
      maxlength: 100,
    },
    category: {
      type: String,
      default: null,
      trim: true,
      maxlength: 100,
    },
    /** Default tax rate applied to this item on invoices (% e.g. 17 for 17% GST) */
    taxRate: {
      type: Number,
      default: null,
      min: 0,
      max: 100,
    },
    /** Preferred vendor — optionally linked to a Vendor document */
    preferredVendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      default: null,
    },
    /** Valuation method for COGS — 'weighted_average' | 'fifo' */
    valuationMethod: {
      type: String,
      default: 'weighted_average',
      enum: ['weighted_average', 'fifo'],
    },
    /** FIFO cost layers (oldest first): each purchase batch's remaining qty + unit cost. */
    costLayers: {
      type: [
        {
          _id: false,
          qty: { type: Number, required: true },
          unitCost: { type: Number, required: true },
          addedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
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

inventoryItemSchema.index({ businessId: 1, isActive: 1 });
inventoryItemSchema.index({ businessId: 1, sku: 1 }, {
  unique: true,
  partialFilterExpression: { sku: { $ne: null } },
});
inventoryItemSchema.index({ businessId: 1, barcode: 1 }, {
  unique: true,
  sparse: true,
  partialFilterExpression: { barcode: { $ne: null } },
});
inventoryItemSchema.index({ businessId: 1, name: 1 });
inventoryItemSchema.index({ businessId: 1, currentStock: 1 });
inventoryItemSchema.index({ businessId: 1, category: 1 });

/**
 * Update the weighted-average unit cost when adding stock.
 * newAvgCost = (currentStock * unitCostPrice + addedQty * addedCostPerUnit) / (currentStock + addedQty)
 */
inventoryItemSchema.methods.addStock = async function (qty, costPerUnit, session = null) {
  if (qty <= 0) throw new Error('Quantity must be positive');
  const totalValue = this.currentStock * this.unitCostPrice + qty * costPerUnit;
  const newQty = this.currentStock + qty;
  this.unitCostPrice = newQty > 0 ? totalValue / newQty : costPerUnit;
  this.currentStock = newQty;
  // FIFO: record a cost layer for this batch (weighted-avg unitCostPrice stays as a
  // valuation summary and equals the layers' average after each add).
  if (this.valuationMethod === 'fifo') {
    if (!Array.isArray(this.costLayers)) this.costLayers = [];
    this.costLayers.push({ qty, unitCost: costPerUnit, addedAt: new Date() });
  }
  await this.save({ session });
  return this;
};

/**
 * Reduce stock and return the COGS amount. Weighted-average uses unitCostPrice;
 * FIFO consumes oldest cost layers first (and keeps unitCostPrice in step with the
 * remaining layers so inventory valuation stays consistent).
 */
inventoryItemSchema.methods.reduceStock = async function (qty, session = null) {
  if (qty <= 0) throw new Error('Quantity must be positive');
  if (qty > this.currentStock) throw new Error(`Insufficient stock: ${this.currentStock} available`);

  // INV-1 — quote and consume share ONE costing path (quoteConsumption), so the
  // COGS a caller posted from a quote can never diverge from what we consume here.
  const { quoteConsumption } = require('../utils/inventoryCosting.util');
  const quote = quoteConsumption(this, qty);
  if (quote.method === 'fifo') {
    this.costLayers = quote.remainingLayers;
    const remQty = this.currentStock - qty;
    const remVal = quote.remainingLayers.reduce((s, l) => s + l.qty * l.unitCost, 0);
    if (remQty > 0) this.unitCostPrice = Math.round((remVal / remQty) * 100) / 100;
  }

  this.currentStock -= qty;
  await this.save({ session });
  return { cogsAmount: quote.cogsAmount, unitCostUsed: quote.unitCostUsed };
};

inventoryItemSchema.statics.getLowStockItems = function (businessId) {
  return this.find({
    businessId,
    isActive: true,
    $expr: { $lte: ['$currentStock', '$reorderLevel'] },
  }).sort({ currentStock: 1 }).lean();
};

const InventoryItem = mongoose.model('InventoryItem', inventoryItemSchema);
module.exports = InventoryItem;

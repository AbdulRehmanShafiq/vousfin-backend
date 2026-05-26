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
inventoryItemSchema.index({ businessId: 1, name: 1 });
inventoryItemSchema.index({ businessId: 1, currentStock: 1 });

/**
 * Update the weighted-average unit cost when adding stock.
 * newAvgCost = (currentStock * unitCostPrice + addedQty * addedCostPerUnit) / (currentStock + addedQty)
 */
inventoryItemSchema.methods.addStock = async function (qty, costPerUnit) {
  if (qty <= 0) throw new Error('Quantity must be positive');
  const totalValue = this.currentStock * this.unitCostPrice + qty * costPerUnit;
  const newQty = this.currentStock + qty;
  this.unitCostPrice = newQty > 0 ? totalValue / newQty : costPerUnit;
  this.currentStock = newQty;
  await this.save();
  return this;
};

/**
 * Reduce stock and return the COGS amount (qty × unitCostPrice).
 */
inventoryItemSchema.methods.reduceStock = async function (qty) {
  if (qty <= 0) throw new Error('Quantity must be positive');
  if (qty > this.currentStock) throw new Error(`Insufficient stock: ${this.currentStock} available`);
  const cogs = qty * this.unitCostPrice;
  this.currentStock -= qty;
  await this.save();
  return { cogsAmount: Math.round(cogs * 100) / 100, unitCostUsed: this.unitCostPrice };
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

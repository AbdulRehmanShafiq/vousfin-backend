// models/BillOfMaterials.model.js
//
// Inventory Engine Phase 9 — what a finished item is made of.
//
// A BOM is a recipe, not an accounting record: it holds no value and posts no
// journal. Value only moves when an assembly is actually built (see
// assembly.service), which consumes the components at their real cost and
// produces the finished good at the rolled-up total.
'use strict';

const mongoose = require('mongoose');

const componentSchema = new mongoose.Schema(
  {
    _id: false,
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
    /** Units of this component per ONE unit of the finished good. */
    qtyPerUnit: { type: Number, required: true, min: 0.000001 },
    /** Expected wastage, e.g. 5 = 5% more is consumed than the recipe needs. */
    scrapPct: { type: Number, default: 0, min: 0, max: 100 },
  },
  { _id: false }
);

const bomSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    /** The finished good this recipe produces. */
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InventoryItem',
      required: true,
      index: true,
    },
    name: { type: String, default: null, trim: true, maxlength: 160 },
    /** Units produced by one run of this recipe (e.g. a batch of 10). */
    outputQty: { type: Number, default: 1, min: 0.000001 },
    components: { type: [componentSchema], default: [] },
    /** Labour/overhead added per run, capitalized into the finished good. */
    labourCostPerRun: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
    notes: { type: String, default: null, trim: true, maxlength: 500 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    toJSON: { transform: (doc, ret) => { delete ret.__v; return ret; } },
  }
);

bomSchema.index({ businessId: 1, itemId: 1, isActive: 1 });

module.exports = mongoose.model('BillOfMaterials', bomSchema);

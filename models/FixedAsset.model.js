// models/FixedAsset.model.js — Fixed Asset Register (PPE)
'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;

const fixedAssetSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    category: { type: String, trim: true, default: 'Equipment', maxlength: 80 },
    acquisitionDate: { type: Date, required: true },
    acquisitionCost: { type: Number, required: true, min: 0 },
    salvageValue: { type: Number, default: 0, min: 0 },
    usefulLifeYears: { type: Number, required: true, min: 1, max: 100 },
    depreciationMethod: { type: String, enum: ['straight_line', 'declining_balance'], default: 'straight_line' },
    accumulatedDepreciation: { type: Number, default: 0, min: 0 },
    depreciationPostedYears: { type: Number, default: 0, min: 0 }, // annual periods already posted
    lastDepreciationDate: { type: Date, default: null },
    assetAccountCode: { type: String, default: '1220' }, // which asset account holds the cost
    status: { type: String, enum: ['active', 'disposed', 'fully_depreciated'], default: 'active' },
    disposalDate: { type: Date, default: null },
    disposalProceeds: { type: Number, default: null },
    disposalGainLoss: { type: Number, default: null }, // + gain, - loss
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

fixedAssetSchema.set('toJSON', { transform: (_doc, ret) => { delete ret.__v; return ret; } });

module.exports = mongoose.model('FixedAsset', fixedAssetSchema);

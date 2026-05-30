// models/ForecastDatasetRegistry.model.js
//
// Forecast Platform — Foundation (F1). FORECASTING METADATA REGISTRY.
//
// Lineage + reproducibility record for every dataset build: which tenant, which
// sources, granularity, date range, row count, base currency, a content hash
// (so an identical rebuild is detectable), the validation verdict, and a version
// counter. This is what makes a forecast auditable back to the exact data that
// produced it.
//
'use strict';
const mongoose = require('mongoose');

const datasetRegistrySchema = new mongoose.Schema(
  {
    businessId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    datasetKey:   { type: String, required: true },
    granularity:  { type: String, enum: ['daily', 'weekly', 'monthly', 'quarterly'], required: true },
    version:      { type: Number, default: 1 },

    // Provenance.
    sources:      [{ type: String }],            // ['journal_entries','invoices','bills',...]
    rangeStart:   { type: Date, required: true },
    rangeEnd:     { type: Date, required: true },
    rowCount:     { type: Number, default: 0 },
    baseCurrency: { type: String, required: true },
    tzOffsetMinutes: { type: Number, default: 0 },
    contentHash:  { type: String, default: null, index: true },  // sha256 of the normalized rows

    // Validation verdict (from dataValidation.validateDataset).
    validation: {
      passed:   { type: Boolean, default: false },
      errors:   [{ type: String }],
      warnings: [{ type: String }],
      summary:  { type: String, default: null },
    },

    status:    { type: String, enum: ['built', 'validated', 'failed', 'materialized'], default: 'built', index: true },
    builtBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    builtAt:   { type: Date, default: Date.now },
  },
  { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } }
);

datasetRegistrySchema.index({ businessId: 1, datasetKey: 1, granularity: 1, version: -1 });

module.exports = mongoose.model('ForecastDatasetRegistry', datasetRegistrySchema);

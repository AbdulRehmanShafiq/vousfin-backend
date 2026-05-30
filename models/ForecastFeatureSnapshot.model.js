// models/ForecastFeatureSnapshot.model.js
//
// Forecast Platform — Foundation (F1). FEATURE STORE + HISTORICAL SNAPSHOT.
//
// One row per (tenant, dataset, granularity, period). Stores the leakage-safe
// point-in-time feature vector and the realized target for that period, plus the
// `knowledgeDate` (the cutoff after which no data may have informed the row).
// Append-only and idempotent (unique key) so it doubles as the historical
// snapshot system — backtests read features "as known on" any past date.
//
// (Mongo today; the schema maps 1:1 onto a TimescaleDB hypertable keyed on
// periodStart for the target-stack migration.)
//
'use strict';
const mongoose = require('mongoose');

const featureSnapshotSchema = new mongoose.Schema(
  {
    businessId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    datasetKey:    { type: String, required: true },              // e.g. "core-financials"
    granularity:   { type: String, enum: ['daily', 'weekly', 'monthly', 'quarterly'], required: true },

    periodKey:     { type: String, required: true },              // "2026-01", "2026-W02", "2026-Q1"
    periodStart:   { type: Date, required: true, index: true },
    periodEnd:     { type: Date, required: true },
    // Cutoff after which NO data informed this row (leakage guard for backtests).
    knowledgeDate: { type: Date, required: true, index: true },

    baseCurrency:  { type: String, required: true },
    sourceVersion: { type: String, default: null },               // dataset content hash that produced it

    // Point-in-time engineered features (lags, rolling stats, calendar, AR/AP …).
    features:      { type: mongoose.Schema.Types.Mixed, default: {} },
    // Realized target metrics for the period (revenue/expenses/cashFlow/…).
    target:        { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } }
);

// Idempotent identity — re-materializing a period overwrites, never duplicates.
featureSnapshotSchema.index({ businessId: 1, datasetKey: 1, granularity: 1, periodKey: 1 }, { unique: true });
featureSnapshotSchema.index({ businessId: 1, granularity: 1, periodStart: 1 });
featureSnapshotSchema.index({ businessId: 1, knowledgeDate: 1 });

module.exports = mongoose.model('ForecastFeatureSnapshot', featureSnapshotSchema);

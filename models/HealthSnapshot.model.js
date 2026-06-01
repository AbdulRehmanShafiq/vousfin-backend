// models/HealthSnapshot.model.js
//
// H5 — daily snapshot of the Business Health Score, so the score is trendable
// and auditable over time ("your health went 62 → 68 this month"). One snapshot
// per business per calendar day (idempotent upsert on { businessId, date }).
//
'use strict';
const mongoose = require('mongoose');

const healthSnapshotSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    date:       { type: String, required: true }, // 'YYYY-MM-DD' (the snapshot day)

    overall:    { type: Number, required: true },
    confidence: { type: String, default: null },  // insufficient | low | medium | high

    // Per-category sub-scores (null when not computable that day)
    categories: {
      liquidity:     { type: Number, default: null },
      profitability: { type: Number, default: null },
      efficiency:    { type: Number, default: null },
      leverage:      { type: Number, default: null },
      tax:           { type: Number, default: null },
    },

    // A few headline metrics, for audit / richer trends later
    metrics: { type: mongoose.Schema.Types.Mixed, default: {} },

    capturedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } }
);

// One row per business per day — repeated dashboard views upsert the same row.
healthSnapshotSchema.index({ businessId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('HealthSnapshot', healthSnapshotSchema);

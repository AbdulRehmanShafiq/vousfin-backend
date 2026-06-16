// models/EntityMemory.model.js
//
// Autonomy roadmap Phase 1 — per-entity memory. A generic learned-association
// store ("this vendor → that GL account", "this description → that category",
// "this customer → these terms") that raises future suggestion accuracy. Keyed
// by (businessId, kind, key); value is whatever the agent learned.
//
'use strict';
const mongoose = require('mongoose');

const entityMemorySchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    kind:       { type: String, required: true },              // vendor_account | description_category | customer_terms | …
    key:        { type: String, required: true },              // the entity identifier
    value:      { type: mongoose.Schema.Types.Mixed, default: null },
    hits:       { type: Number, default: 1 },                  // reinforcement count
    lastSeen:   { type: Date, default: Date.now },
  },
  { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } },
);

entityMemorySchema.index({ businessId: 1, kind: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('EntityMemory', entityMemorySchema);

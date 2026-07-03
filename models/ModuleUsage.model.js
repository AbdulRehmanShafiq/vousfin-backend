// models/ModuleUsage.model.js — per-user, per-business module usage counter that
// powers the dashboard "most-used" shortcuts. One row per (business, user,
// module); `count` reinforces on each open/search and `lastUsedAt` tracks recency.
'use strict';
const mongoose = require('mongoose');

const moduleUsageSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    moduleKey:  { type: String, required: true },            // stable key/path segment for the module
    label:      { type: String, required: true, maxlength: 60 },
    path:       { type: String, required: true, maxlength: 200 },
    count:      { type: Number, default: 1 },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

moduleUsageSchema.index({ businessId: 1, userId: 1, moduleKey: 1 }, { unique: true });
moduleUsageSchema.index({ businessId: 1, userId: 1, count: -1, lastUsedAt: -1 });

module.exports = mongoose.model('ModuleUsage', moduleUsageSchema);

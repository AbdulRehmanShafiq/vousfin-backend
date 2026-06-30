'use strict';

const mongoose = require('mongoose');

/**
 * SearchLog — command-bar analytics. Privacy by design: it records the
 * normalized search TEXT (app-navigation phrases like "who owes me", which are
 * non-sensitive and are needed so admins can turn failed searches into a help
 * content backlog) but NEVER a userId — events are never tied to a person.
 * Append-only; used only for aggregate insight.
 */
const searchLogSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    kind: { type: String, enum: ['catalog', 'howto'], default: 'catalog', index: true },
    query: { type: String, required: true, trim: true, maxlength: 200 },
    queryHash: { type: String, required: true, index: true }, // sha256 of the normalized query, for grouping
    resultClickedId: { type: String, default: null }, // catalog entry id the user opened, if any
    noResult: { type: Boolean, default: false, index: true },
  },
  { timestamps: true, collection: 'searchLogs' }
);

searchLogSchema.index({ businessId: 1, createdAt: -1 });

module.exports = mongoose.model('SearchLog', searchLogSchema);

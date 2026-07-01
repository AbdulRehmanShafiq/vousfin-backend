// models/AIDecision.model.js — Intelligence Roadmap Phase 0: AI Decision Ledger.
//
// Append-only lineage of every AI action: what it saw (inputsSummary), the
// alternatives it weighed (candidates), what it decided (decision), how sure it
// was (confidence), which model, and the user's eventual verdict (outcome). The
// core fields are immutable; only the one-time outcome set is permitted, which
// is why findOneAndUpdate is NOT blocked while updateMany/delete are.
'use strict';
const mongoose = require('mongoose');
const { AI_DECISION_KINDS, AI_DECISION_OUTCOMES } = require('../config/constants');

const aiDecisionSchema = new mongoose.Schema(
  {
    businessId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    kind:          { type: String, enum: Object.values(AI_DECISION_KINDS), required: true, index: true },
    inputsSummary: { type: String, required: true, maxlength: 2000 },
    candidates:    { type: [mongoose.Schema.Types.Mixed], default: [] },
    decision:      { type: mongoose.Schema.Types.Mixed, default: null },
    confidence:    { type: Number, min: 0, max: 1, default: null },
    model:         { type: String, maxlength: 80, default: null },
    promptVersion: { type: String, maxlength: 40, default: null },
    linkedEntityId:{ type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    outcome:       { type: String, enum: Object.values(AI_DECISION_OUTCOMES), default: AI_DECISION_OUTCOMES.PENDING, index: true },
    correctedTo:   { type: mongoose.Schema.Types.Mixed, default: null },
    resolvedAt:    { type: Date, default: null },
  },
  { timestamps: true, collection: 'aiDecisions' }
);

// Query paths: per-business listing/filtering, and outcome analytics for learning.
aiDecisionSchema.index({ businessId: 1, createdAt: -1 });
aiDecisionSchema.index({ businessId: 1, kind: 1, outcome: 1, createdAt: -1 });

// Append-only: bulk updates and any delete are forbidden. A single
// findOneAndUpdate is allowed solely to set the one-time outcome (guarded in the
// repository via applyOutcome).
aiDecisionSchema.pre('updateMany', function () { throw new Error('AI decisions are immutable – bulk updates not allowed'); });
aiDecisionSchema.pre('deleteOne',  function () { throw new Error('AI decisions are immutable – deletions not allowed'); });
aiDecisionSchema.pre('deleteMany', function () { throw new Error('AI decisions are immutable – deletions not allowed'); });

module.exports = mongoose.model('AIDecision', aiDecisionSchema);

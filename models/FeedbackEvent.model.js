// models/FeedbackEvent.model.js
//
// Autonomy roadmap Phase 1 — the learning loop's raw signal. Every human verdict
// on a proposed action (approved as-is / edited / rejected) is recorded here, so
// the system can measure its own accuracy per capability and earn more autonomy.
//
'use strict';
const mongoose = require('mongoose');

const feedbackEventSchema = new mongoose.Schema(
  {
    businessId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    capability:       { type: String, required: true },
    actionType:       { type: String, default: '' },
    proposedActionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProposedAction', default: null },

    verdict:    { type: String, enum: ['approved', 'edited', 'rejected'], required: true },
    confidence: { type: Number, default: null },                 // confidence at proposal time
    correction: { type: mongoose.Schema.Types.Mixed, default: null }, // for edits: { before, after }

    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } },
);

feedbackEventSchema.index({ businessId: 1, capability: 1, createdAt: -1 });

module.exports = mongoose.model('FeedbackEvent', feedbackEventSchema);

// models/PlanRun.model.js
//
// Autonomy roadmap Phase 6 — a recorded run of an orchestrated playbook.
//
// The Orchestrator sequences several agents into one named routine (the weekly
// cash cycle, the monthly close, …). Each run is recorded here so the owner has
// a single observable plan: which steps ran, in what order, what each surfaced,
// and when. It records WHAT was orchestrated — the actual proposals live as
// ProposedActions in the inbox.
//
'use strict';
const mongoose = require('mongoose');

const stepSchema = new mongoose.Schema({
  capability: { type: String, required: true },   // reconciliation | collections | payments | close
  label:      { type: String, default: '' },
  status:     { type: String, enum: ['pending', 'done', 'failed'], default: 'pending' },
  proposed:   { type: Number, default: 0 },        // how many actions this step surfaced
  ranAt:      { type: Date, default: null },
  error:      { type: String, default: null },
}, { _id: false });

const planRunSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    playbook:   { type: String, required: true },   // weekly_cash | monthly_close | …
    name:       { type: String, default: '' },
    status:     { type: String, enum: ['running', 'completed', 'failed'], default: 'running' },
    steps:      { type: [stepSchema], default: [] },
    totalProposed: { type: Number, default: 0 },
    startedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    startedAt:  { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } },
);

planRunSchema.index({ businessId: 1, startedAt: -1 });

module.exports = mongoose.model('PlanRun', planRunSchema);

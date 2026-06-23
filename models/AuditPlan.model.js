// models/AuditPlan.model.js — Phase 6C (Internal Audit)
//
// An audit plan defines a review scope and period for a business.
// When the plan is activated, a sample of journal entries is drawn
// and findings are raised against them.
'use strict';
const mongoose = require('mongoose');

const auditPlanSchema = new mongoose.Schema(
  {
    businessId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name:           { type: String, required: true, trim: true, maxlength: 120 },
    scope:          { type: String, default: '', maxlength: 300 },
    periodStart:    { type: Date, required: true },
    periodEnd:      { type: Date, required: true },
    sampleStrategy: { type: String, enum: ['random', 'risk_based'], default: 'risk_based' },
    sampleSize:     { type: Number, default: 10, min: 1, max: 100 },
    status:         { type: String, enum: ['draft', 'in_progress', 'completed'], default: 'draft' },
    createdBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    toJSON: { transform: (doc, ret) => { delete ret.__v; return ret; } },
  },
);

module.exports = mongoose.model('AuditPlan', auditPlanSchema);

// models/AuditFinding.model.js — Phase 6C (Internal Audit)
//
// A finding raised during an audit plan — typically linked to a journal entry
// that exhibited a control weakness or error. Management records a response
// and tracks resolution.
'use strict';
const mongoose = require('mongoose');

const auditFindingSchema = new mongoose.Schema(
  {
    businessId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    planId:              { type: mongoose.Schema.Types.ObjectId, ref: 'AuditPlan', required: true, index: true },
    linkedEntityType:    { type: String, default: 'journalEntry' },
    linkedEntityId:      { type: mongoose.Schema.Types.ObjectId, default: null },
    observation:         { type: String, required: true, trim: true, maxlength: 1000 },
    riskRating:          { type: String, enum: ['critical', 'high', 'medium', 'low'], default: 'medium' },
    managementResponse:  { type: String, default: '', maxlength: 1000 },
    targetResolutionDate:{ type: Date, default: null },
    status:              { type: String, enum: ['open', 'in_progress', 'resolved'], default: 'open' },
    createdBy:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    toJSON: { transform: (doc, ret) => { delete ret.__v; return ret; } },
  },
);

module.exports = mongoose.model('AuditFinding', auditFindingSchema);

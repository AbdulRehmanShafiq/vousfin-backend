// models/ComplianceObligation.model.js — FR-10.1 Compliance Calendar
'use strict';
const mongoose = require('mongoose');

const complianceObligationSchema = new mongoose.Schema(
  {
    businessId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    code:            { type: String, required: true },
    period:          { type: String, required: true }, // 'YYYY-MM'
    dueDate:         { type: Date, required: true },
    status:          { type: String, enum: ['pending', 'completed', 'overdue', 'waived'], default: 'pending' },
    referenceNumber: { type: String, default: '' },
    notes:           { type: String, default: '' },
    completedAt:     { type: Date, default: null },
    completedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    toJSON: { transform: (doc, ret) => { delete ret.__v; return ret; } },
  },
);

complianceObligationSchema.index({ businessId: 1, code: 1, period: 1 }, { unique: true });

module.exports = mongoose.model('ComplianceObligation', complianceObligationSchema);

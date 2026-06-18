// models/Budget.model.js — FR-04.1 / FR-04.2
'use strict';
const mongoose = require('mongoose');
const { BUDGET_STATUS, BUDGET_STATUS_TRANSITIONS, BUDGET_SCENARIOS } = require('../config/constants');

const budgetLineSchema = new mongoose.Schema({
  accountId:    { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', required: true },
  costCenterId: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
  monthly:      { type: [Number], default: () => Array(12).fill(0),
                  validate: { validator: (a) => Array.isArray(a) && a.length === 12,
                              message: 'monthly must have exactly 12 values' } },
  thresholdPct: { type: Number, default: null },
}, { _id: false });

const budgetSchema = new mongoose.Schema({
  businessId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  name:         { type: String, required: true, trim: true, maxlength: 120 },
  fiscalYearId: { type: mongoose.Schema.Types.ObjectId, ref: 'FiscalYear', required: true },
  scenario:     { type: String, enum: BUDGET_SCENARIOS, default: 'base' },
  version:      { type: Number, default: 1 },
  status:       { type: String, enum: Object.values(BUDGET_STATUS), default: BUDGET_STATUS.DRAFT },
  defaultThresholdPct: { type: Number, default: 10 },
  approvalChain: { type: Array, default: [] },
  createdBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  lines:        { type: [budgetLineSchema], default: [] },
}, { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } });

budgetSchema.index({ businessId: 1, fiscalYearId: 1, scenario: 1, version: 1 });
// At most one active budget per scenario per fiscal year.
budgetSchema.index(
  { businessId: 1, fiscalYearId: 1, scenario: 1 },
  { unique: true, partialFilterExpression: { status: BUDGET_STATUS.ACTIVE } }
);

budgetSchema.statics.canTransition = (from, to) =>
  (BUDGET_STATUS_TRANSITIONS[from] || []).includes(to);

module.exports = mongoose.model('Budget', budgetSchema);

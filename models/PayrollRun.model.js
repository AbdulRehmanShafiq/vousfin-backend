// models/PayrollRun.model.js — FR-08.2
'use strict';
const mongoose = require('mongoose');
const { PAYROLL_RUN_STATUS, PAYROLL_RUN_TRANSITIONS } = require('../config/constants');

const lineSchema = new mongoose.Schema({
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  employeeCode: String, employeeName: String,
  costCenterId: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
  basic: Number, allowancesTotal: Number,
  additions: [{ label: String, amount: Number }],
  gross: Number, taxableIncome: Number, incomeTax: Number,
  eobiEmployee: Number, eobiEmployer: Number, pfEmployee: Number, pfEmployer: Number,
  otherDeductions: [{ label: String, amount: Number }], otherDeductionsTotal: Number,
  netPay: Number,
}, { _id: false });

const payrollRunSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  period:     { type: String, required: true },                 // 'YYYY-MM'
  taxYear:    { type: String, required: true },                 // 'YYYY-YY'
  status:     { type: String, enum: Object.values(PAYROLL_RUN_STATUS), default: PAYROLL_RUN_STATUS.DRAFT },
  lines:      { type: [lineSchema], default: [] },
  totals: {
    gross: Number, incomeTax: Number, eobiEmployee: Number, eobiEmployer: Number,
    pfEmployee: Number, pfEmployer: Number, otherDeductions: Number, netPay: Number,
  },
  postedJournalEntryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry' }],
  reversalJournalEntryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry' }],
  bankAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
  processedBy: mongoose.Schema.Types.ObjectId, processedAt: Date,
  postedBy: mongoose.Schema.Types.ObjectId, postedAt: Date,
  paidAt: Date,
}, { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } });

// One live (non-reversed) run per period.
//
// Expressed as $in over the live statuses, NOT `$ne: REVERSED`: mongod refuses
// a negation in a partialFilterExpression ("Expression not supported in partial
// index: $not"), so the $ne form silently never built — meaning nothing ever
// stopped a business from posting two payroll runs for the same period. $in is
// accepted and says the same thing. Derived from the enum so a new status is
// covered by construction rather than by remembering to edit this list.
payrollRunSchema.index(
  { businessId: 1, period: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: Object.values(PAYROLL_RUN_STATUS).filter((s) => s !== PAYROLL_RUN_STATUS.REVERSED) },
    },
  }
);

payrollRunSchema.statics.canTransition = (from, to) =>
  (PAYROLL_RUN_TRANSITIONS[from] || []).includes(to);

module.exports = mongoose.model('PayrollRun', payrollRunSchema);

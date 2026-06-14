// models/PayrollAccrual.model.js
//
// FR-04.1 (Phase 3) — a minimal monthly record of employer social-security
// obligations (EOBI + SESSI) so the live tax position can track payroll taxes
// without a full payroll module (YAGNI). One row per business per month.
//
// Surfaced in the position only when business.taxConfig.payrollEnabled is true.
//
'use strict';
const mongoose = require('mongoose');

const payrollAccrualSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    month:      { type: String, required: true },               // 'YYYY-MM'
    eobi:       { type: Number, default: 0, min: 0 },           // employer EOBI contribution
    sessi:      { type: Number, default: 0, min: 0 },           // provincial social-security (SESSI/PESSI…)
    createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } }
);

// One accrual per business per month — re-submitting a month overwrites it.
payrollAccrualSchema.index({ businessId: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('PayrollAccrual', payrollAccrualSchema);

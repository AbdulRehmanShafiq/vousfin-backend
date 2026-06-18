// models/Employee.model.js — FR-08.1
'use strict';
const mongoose = require('mongoose');

const salaryVersionSchema = new mongoose.Schema({
  effectiveFrom: { type: Date, required: true },
  basic:         { type: Number, required: true, min: 0 },
  allowances: {
    houseRent:   { type: Number, default: 0, min: 0 },
    medical:     { type: Number, default: 0, min: 0 },
    conveyance:  { type: Number, default: 0, min: 0 },
    special:     { type: Number, default: 0, min: 0 },
    other:       { type: Number, default: 0, min: 0 },
  },
  taxExempt: { medicalCapPctOfBasic: { type: Number, default: 0, min: 0, max: 100 } },
  eobi: {
    enabled:        { type: Boolean, default: false },
    employeeAmount: { type: Number, default: 0, min: 0 },
    employerAmount: { type: Number, default: 0, min: 0 },
  },
  providentFund: {
    enabled:            { type: Boolean, default: false },
    employeePctOfBasic: { type: Number, default: 0, min: 0, max: 100 },
    employerPctOfBasic: { type: Number, default: 0, min: 0, max: 100 },
  },
  recurringDeductions: [{ label: { type: String, trim: true }, amount: { type: Number, min: 0 } }],
}, { _id: false });

const employeeSchema = new mongoose.Schema({
  businessId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  code:        { type: String, required: true, trim: true },
  fullName:    { type: String, required: true, trim: true },
  cnic:        { type: String, trim: true, default: '' },
  ntn:         { type: String, trim: true, default: '' },
  email:       { type: String, trim: true, default: '' },
  phone:       { type: String, trim: true, default: '' },
  designation: { type: String, trim: true, default: '' },
  department:  { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
  joiningDate: { type: Date, default: null },
  bankName:    { type: String, trim: true, default: '' },
  bankAccountTitle: { type: String, trim: true, default: '' },
  iban:        { type: String, trim: true, default: '' },
  status:      { type: String, enum: ['active', 'inactive'], default: 'active' },
  salaryStructure: { type: [salaryVersionSchema], default: [] },
}, { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } });

employeeSchema.index({ businessId: 1, code: 1 }, { unique: true });

/** Pick the salary version in force for a period end date (latest effectiveFrom <= asOf). */
employeeSchema.statics.resolveStructure = function (employee, asOf) {
  const versions = (employee.salaryStructure || [])
    .filter((v) => new Date(v.effectiveFrom) <= new Date(asOf))
    .sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom));
  return versions[0] || null;
};

module.exports = mongoose.model('Employee', employeeSchema);

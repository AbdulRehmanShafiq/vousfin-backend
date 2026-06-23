// models/SodRule.model.js — Phase 6B (Segregation of Duties)
//
// A conflict between two per-business roles: a single person must not hold both
// (e.g. accountant + approver = preparer who can also approve). Pairs are stored
// normalized (roleA <= roleB alphabetically) so order never matters.
'use strict';
const mongoose = require('mongoose');
const { BUSINESS_ROLES } = require('../config/constants');
const ROLES = Object.values(BUSINESS_ROLES);

const sodRuleSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    roleA: { type: String, enum: ROLES, required: true },
    roleB: { type: String, enum: ROLES, required: true },
    reason: { type: String, trim: true, maxlength: 300, default: '' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, toJSON: { transform: (doc, ret) => { delete ret.__v; return ret; } } },
);

// One rule per role-pair per business (pairs are normalized before save).
sodRuleSchema.index({ businessId: 1, roleA: 1, roleB: 1 }, { unique: true });

module.exports = mongoose.model('SodRule', sodRuleSchema);

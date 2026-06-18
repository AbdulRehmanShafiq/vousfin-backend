// models/CostCenter.model.js
//
// SRS FR-07.1 — a first-class cost / profit centre. Lets any GL transaction be
// tagged to a department, branch, project, location or generic cost centre, and
// organised into a hierarchy (a project under a department, etc.). This is the
// dimension that cost-centre P&L, budget-by-department, profitability analysis
// and payroll department tagging all build on.
//
'use strict';
const mongoose = require('mongoose');
const { COST_CENTER_TYPES } = require('../config/constants');

const costCenterSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true,
    },
    code: { type: String, required: true, trim: true, maxlength: 30 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    type: {
      type: String,
      enum: Object.values(COST_CENTER_TYPES),
      default: COST_CENTER_TYPES.DEPARTMENT,
    },
    // Self-referential hierarchy (null = top level).
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
    description: { type: String, default: '', trim: true, maxlength: 300 },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: { transform: (doc, ret) => { delete ret.__v; return ret; } },
  },
);

// Code is unique per business.
costCenterSchema.index({ businessId: 1, code: 1 }, { unique: true });
costCenterSchema.index({ businessId: 1, parentId: 1 });
costCenterSchema.index({ businessId: 1, isActive: 1 });

module.exports = mongoose.model('CostCenter', costCenterSchema);

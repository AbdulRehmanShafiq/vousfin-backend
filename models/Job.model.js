// models/Job.model.js — FR-07.2
'use strict';
const mongoose = require('mongoose');
const { JOB_STATUS, JOB_STATUS_TRANSITIONS, JOB_COST_CATEGORIES } = require('../config/constants');

const costRowSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  category: { type: String, enum: JOB_COST_CATEGORIES, required: true },
  description: { type: String, default: '' },
  amount: { type: Number, required: true, min: 0.01 },
  sourceAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', required: true },
  journalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
}, { _id: false });

const jobSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  code: { type: String, required: true, trim: true, maxlength: 40 },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
  status: { type: String, enum: Object.values(JOB_STATUS), default: JOB_STATUS.OPEN },
  standardCost: {
    material: { type: Number, default: 0 },
    labour:   { type: Number, default: 0 },
    overhead: { type: Number, default: 0 },
  },
  costSheet: { type: [costRowSchema], default: [] },
  wipJournalEntryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry' }],
  completionJournalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
  completedAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } });

jobSchema.index({ businessId: 1, code: 1 }, { unique: true });
jobSchema.statics.canTransition = (from, to) => (JOB_STATUS_TRANSITIONS[from] || []).includes(to);

module.exports = mongoose.model('Job', jobSchema);

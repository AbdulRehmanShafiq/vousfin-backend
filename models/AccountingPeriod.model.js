/**
 * AccountingPeriod.model.js — Phase 5.1 Accounting Period Engine
 *
 * Represents a sub-period within a FiscalYear (monthly, quarterly, or yearly).
 * Monthly periods are auto-generated when a FiscalYear is created.
 *
 * Status lifecycle:  OPEN → CLOSED → LOCKED
 *   OPEN   — normal posting allowed
 *   CLOSED — read-only; new postings rejected (admin can reopen with reason)
 *   LOCKED — permanent; only super-admin override allowed
 *
 * Period locking is checked in transaction.service.js before every write.
 */

'use strict';

const mongoose = require('mongoose');
const { PERIOD_STATUS, PERIOD_TYPE } = require('../config/constants');

const auditEntrySchema = new mongoose.Schema(
  {
    action:          { type: String, required: true },
    performedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    performedAt:     { type: Date, default: Date.now },
    reason:          { type: String, maxlength: 500, default: '' },
    isAdminOverride: { type: Boolean, default: false },
  },
  { _id: false }
);

const accountingPeriodSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },

    fiscalYearId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FiscalYear',
      required: true,
      index: true,
    },

    periodType: {
      type: String,
      enum: Object.values(PERIOD_TYPE),
      required: true,
      default: PERIOD_TYPE.MONTHLY,
    },

    // For MONTHLY: 1–12. For QUARTERLY: 1–4. For YEARLY: 1.
    periodNumber: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
    },

    name: {
      type: String,
      required: true,
      maxlength: 50,
      trim: true,
      // e.g. "Jan 2024", "Q1 2024", "FY 2024"
    },

    startDate: { type: Date, required: true },
    endDate:   { type: Date, required: true },

    status: {
      type: String,
      enum: Object.values(PERIOD_STATUS),
      default: PERIOD_STATUS.OPEN,
      index: true,
    },

    // Snapshot totals written at close time (for quick reporting)
    closingSummary: {
      totalRevenue:  { type: Number, default: 0 },
      totalExpenses: { type: Number, default: 0 },
      netIncome:     { type: Number, default: 0 },
      transactionCount: { type: Number, default: 0 },
    },

    // IDs of closing/adjusting entries generated for this period
    closingEntryIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
    }],

    // Append-only audit trail
    auditTrail: [auditEntrySchema],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
// Unique: one period per type+number per fiscal year
accountingPeriodSchema.index({ fiscalYearId: 1, periodType: 1, periodNumber: 1 }, { unique: true });
accountingPeriodSchema.index({ businessId: 1, startDate: 1, endDate: 1 });
accountingPeriodSchema.index({ businessId: 1, status: 1 });

// ── Pre-save: endDate must be after startDate ─────────────────────────────────
// Mongoose 9 removed the next() callback for middleware — a sync hook signals an
// error by throwing (calling next() throws "next is not a function").
accountingPeriodSchema.pre('save', function () {
  if (this.endDate <= this.startDate) {
    throw new Error('Period endDate must be after startDate');
  }
});

/**
 * Static: find the period that covers a given date for a business.
 * Used by the period-lock middleware.
 * Returns null if no period exists (no restriction).
 */
accountingPeriodSchema.statics.findCoveringPeriod = async function (businessId, date, periodType = PERIOD_TYPE.MONTHLY) {
  const d = new Date(date);
  return this.findOne({
    businessId,
    periodType,
    startDate: { $lte: d },
    endDate:   { $gte: d },
  }).lean();
};

module.exports = mongoose.model('AccountingPeriod', accountingPeriodSchema);

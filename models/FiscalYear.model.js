/**
 * FiscalYear.model.js — Phase 5.1 Accounting Period Engine
 *
 * Represents a 12-month accounting year for a business.
 * Controls the lifecycle: OPEN → CLOSED → LOCKED.
 *
 * Relationships:
 *  - One business has many fiscal years (non-overlapping)
 *  - One fiscal year has up to 12 monthly AccountingPeriods (auto-generated on create)
 *  - Closing entries are JournalEntry documents with entryType = 'closing'
 */

'use strict';

const mongoose = require('mongoose');
const { FISCAL_YEAR_STATUS } = require('../config/constants');

const periodAuditSchema = new mongoose.Schema(
  {
    action:    { type: String, required: true },  // 'closed' | 'locked' | 'reopened'
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    performedAt: { type: Date, default: Date.now },
    reason:    { type: String, maxlength: 500, default: '' },
    isAdminOverride: { type: Boolean, default: false },
  },
  { _id: false }
);

const fiscalYearSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },

    // e.g. "FY 2024-25" or "FY 2025"
    name: {
      type: String,
      required: true,
      maxlength: 50,
      trim: true,
    },

    startDate: {
      type: Date,
      required: true,
    },

    endDate: {
      type: Date,
      required: true,
    },

    status: {
      type: String,
      enum: Object.values(FISCAL_YEAR_STATUS),
      default: FISCAL_YEAR_STATUS.OPEN,
      index: true,
    },

    // IDs of closing journal entries created when this year was closed
    closingEntryIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
    }],

    // ID of the opening balance journal entry for the NEXT fiscal year
    // Set after runOpeningBalances() completes
    openingBalanceEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
    },

    // Retained earnings transferred during year-end close
    retainedEarningsTransferred: {
      type: Number,
      default: 0,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // Immutable audit trail — append-only via service layer
    auditTrail: [periodAuditSchema],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
  }
);

// ── Indexes ──────────────────────────────────────────────────────────────────
// Unique: a business cannot have two fiscal years with the same start date
fiscalYearSchema.index({ businessId: 1, startDate: 1 }, { unique: true });
fiscalYearSchema.index({ businessId: 1, status: 1 });

// ── Validation: endDate must be after startDate ──────────────────────────────
fiscalYearSchema.pre('save', function (next) {
  if (this.endDate <= this.startDate) {
    return next(new Error('Fiscal year endDate must be after startDate'));
  }
  next();
});

// ── Virtual: duration in months ──────────────────────────────────────────────
fiscalYearSchema.virtual('durationMonths').get(function () {
  const start = new Date(this.startDate);
  const end   = new Date(this.endDate);
  return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1;
});

module.exports = mongoose.model('FiscalYear', fiscalYearSchema);

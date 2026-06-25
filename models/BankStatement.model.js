// models/BankStatement.model.js
//
// Feature #7 — Real bank-statement reconciliation feed.
//
// A BankStatement is an imported bank statement for ONE bank/cash account. Each
// embedded line is matched to an existing journal entry that touches that
// account. Matching state lives ONLY here — the journal entry is never mutated,
// so journal entries stay immutable and the ledger remains the single source of
// truth. A JE's "reconciled" status is derived from whether a statement line
// references it (matchedJournalEntryId).
//
'use strict';
const mongoose = require('mongoose');
const {
  BANK_LINE_DIRECTION, BANK_LINE_STATUS, BANK_STATEMENT_STATUS,
} = require('../config/constants');

const bankLineSchema = new mongoose.Schema(
  {
    // Stable identifier for the line within this statement (used by the API).
    lineRef:     { type: String, required: true },
    date:        { type: Date, required: true },
    description: { type: String, default: '', trim: true, maxlength: 500 },
    reference:   { type: String, default: '', trim: true, maxlength: 100 },
    // Positive magnitude; direction carries the sign meaning.
    amount:      { type: Number, required: true, min: 0 },
    direction:   { type: String, enum: Object.values(BANK_LINE_DIRECTION), required: true },
    runningBalance: { type: Number, default: null },

    status: {
      type: String,
      enum: Object.values(BANK_LINE_STATUS),
      default: BANK_LINE_STATUS.UNMATCHED,
    },
    matchedJournalEntryId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null,
    },
    matchScore:  { type: Number, default: null },   // 0–100 when auto/confirmed
    autoMatched: { type: Boolean, default: false },  // true if the engine linked it
    matchedAt:   { type: Date, default: null },
    matchedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    note:        { type: String, default: null, maxlength: 300 },
    proposedMatches: [
      {
        journalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', required: true },
        description: { type: String, default: '' },
        date: { type: Date, required: true },
        amount: { type: Number, required: true },
        score: { type: Number, required: true },
      }
    ],
  },
  { _id: false }
);

const bankStatementSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true,
    },
    bankAccountId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', required: true, index: true,
    },
    bankAccountName: { type: String, default: null },   // snapshot for display

    name:      { type: String, required: true, trim: true, maxlength: 150 },
    fileName:  { type: String, default: null },

    periodStart: { type: Date, default: null },
    periodEnd:   { type: Date, default: null },
    openingBalance: { type: Number, default: null },
    closingBalance: { type: Number, default: null },

    lines: [bankLineSchema],

    status: {
      type: String,
      enum: Object.values(BANK_STATEMENT_STATUS),
      default: BANK_STATEMENT_STATUS.IN_PROGRESS,
      index: true,
    },
    importedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    completedAt:  { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { transform: (doc, ret) => { delete ret.__v; return ret; } },
  }
);

bankStatementSchema.index({ businessId: 1, bankAccountId: 1, createdAt: -1 });

bankStatementSchema.virtual('bankAccount', {
  ref: 'ChartOfAccount', localField: 'bankAccountId', foreignField: '_id', justOne: true,
});

const BankStatement = mongoose.model('BankStatement', bankStatementSchema);
module.exports = BankStatement;

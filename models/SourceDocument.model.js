// models/SourceDocument.model.js
//
// Autonomy roadmap Phase 2 — the Bookkeeper agent's intake record.
//
// A SourceDocument is the raw thing the owner hands the books: a typed/pasted
// bill, a forwarded email, an uploaded receipt (text already extracted), or a
// bank-feed line. The Bookkeeper reads it, proposes a journal entry (a
// ProposedAction of type post_journal), and — depending on the autonomy dial —
// either queues it for approval or auto-posts it.
//
// IMPORTANT: a SourceDocument is NOT a ledger record. No balances move while it
// sits here. Only the ProposedAction's executor posts the one authoritative,
// immutable JournalEntry. `journalEntryId` links the two once posted.
//
'use strict';
const mongoose = require('mongoose');
const { SOURCE_DOCUMENT_SOURCES, SOURCE_DOCUMENT_STATUS } = require('../config/constants');

const sourceDocumentSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },

    source: {
      type: String,
      enum: Object.values(SOURCE_DOCUMENT_SOURCES),
      default: SOURCE_DOCUMENT_SOURCES.MANUAL,
    },
    // The text the Bookkeeper reads (a bill's wording, an email body, a feed line).
    rawText: { type: String, required: true, trim: true, maxlength: 5000 },

    status: {
      type: String,
      enum: Object.values(SOURCE_DOCUMENT_STATUS),
      default: SOURCE_DOCUMENT_STATUS.RECEIVED,
      index: true,
    },

    // What the Bookkeeper understood — a small, human-readable preview.
    extracted: { type: mongoose.Schema.Types.Mixed, default: null },
    confidence: { type: Number, default: null, min: 0, max: 1 },

    // The action it produced + the ledger entry it became (set once posted).
    proposedActionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProposedAction', default: null },
    journalEntryId:   { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },

    // Why a read failed, when status === failed.
    error: { type: String, default: null },

    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } },
);

sourceDocumentSchema.index({ businessId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('SourceDocument', sourceDocumentSchema);

// models/CreditNote.model.js
//
// Phase 2 — Credit Note / Debit Note domain entity.
//
// Linked to an originating Invoice.  Supports:
//   - Partial credit (selected line items or amounts)
//   - Full reversal (mirrors all line items)
//   - Debit notes (adjustment that increases amount owed)
//   - Linked to JournalEntry for ledger posting
//
const mongoose = require('mongoose');
const { APPROVAL_STATUS, APPROVER_ROLES } = require('../config/constants');

// ── Credit Note line item ────────────────────────────────────────────────────

const cnLineItemSchema = new mongoose.Schema(
  {
    originalLineItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    name:        { type: String, required: true, trim: true, maxlength: 300 },
    description: { type: String, default: null, trim: true, maxlength: 500 },
    quantity:    { type: Number, required: true, min: 0.0001 },
    unitPrice:   { type: Number, required: true, min: 0 },
    taxRate:     { type: Number, default: 0, min: 0, max: 100 },
    taxAmount:   { type: Number, default: 0, min: 0 },
    lineTotal:   { type: Number, default: 0, min: 0 },
    accountId:   { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
  },
  { _id: true }
);

// ── Main schema ──────────────────────────────────────────────────────────────

const CREDIT_NOTE_TYPES = ['credit_note', 'debit_note'];
const CREDIT_NOTE_STATES = ['draft', 'approved', 'applied', 'cancelled'];

const creditNoteSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },

    creditNoteNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
      index: true,
    },

    noteType: {
      type: String,
      enum: CREDIT_NOTE_TYPES,
      default: 'credit_note',
    },

    // ── Link to originating invoice ──────────────────────────────────
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Invoice',
      required: true,
      index: true,
    },
    invoiceNumber: { type: String, default: null },

    linkedJournalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
    },

    // ── Customer ─────────────────────────────────────────────────────
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
    customerSnapshot: {
      fullName:     { type: String, default: null },
      businessName: { type: String, default: null },
      email:        { type: String, default: null },
    },

    // ── Line items ───────────────────────────────────────────────────
    lineItems: [cnLineItemSchema],

    // ── Totals ───────────────────────────────────────────────────────
    subtotal:    { type: Number, default: 0, min: 0 },
    taxAmount:   { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0.01 },
    currencyCode:{ type: String, default: 'PKR', uppercase: true, maxlength: 3 },

    // ── Multi-currency ───────────────────────────────────────────────
    baseCurrencyCode:  { type: String, default: 'PKR', uppercase: true, maxlength: 3 },
    exchangeRate:      { type: Number, default: 1, min: 0 },
    baseCurrencyTotal: { type: Number, default: null },

    // ── Lifecycle ────────────────────────────────────────────────────
    state: {
      type: String,
      enum: CREDIT_NOTE_STATES,
      default: 'draft',
      index: true,
    },
    issueDate: { type: Date, required: true },
    reason:    { type: String, default: null, maxlength: 1000, trim: true },
    notes:     { type: String, default: null, maxlength: 1000, trim: true },

    // ── Audit ────────────────────────────────────────────────────────
    createdBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    lastModifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt:     { type: Date, default: null },

    isArchived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => { delete ret.__v; return ret; },
    },
  }
);

// ── Indexes ──────────────────────────────────────────────────────────────────
creditNoteSchema.index({ businessId: 1, creditNoteNumber: 1 }, { unique: true, sparse: true });
creditNoteSchema.index({ businessId: 1, invoiceId: 1 });
creditNoteSchema.index({ businessId: 1, state: 1, createdAt: -1 });

// ── Pre-save: compute totals ─────────────────────────────────────────────────
creditNoteSchema.pre('save', function () {
  const r2 = (v) => Math.round(v * 100) / 100;
  if (this.lineItems && this.lineItems.length > 0) {
    let sub = 0, tax = 0;
    for (const li of this.lineItems) {
      const gross = r2(li.quantity * li.unitPrice);
      const t = li.taxRate > 0 ? r2(gross * li.taxRate / 100) : 0;
      li.taxAmount = t;
      li.lineTotal = r2(gross + t);
      sub += gross;
      tax += t;
    }
    this.subtotal = r2(sub);
    this.taxAmount = r2(tax);
    this.totalAmount = r2(sub + tax);
  }
  if (this.exchangeRate && this.exchangeRate !== 1 && this.totalAmount) {
    this.baseCurrencyTotal = r2(this.totalAmount * this.exchangeRate);
  } else {
    this.baseCurrencyTotal = this.totalAmount;
  }
});

const CreditNote = mongoose.model('CreditNote', creditNoteSchema);
module.exports = CreditNote;
module.exports.CREDIT_NOTE_TYPES = CREDIT_NOTE_TYPES;
module.exports.CREDIT_NOTE_STATES = CREDIT_NOTE_STATES;

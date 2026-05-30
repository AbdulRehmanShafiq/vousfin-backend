// models/Invoice.model.js
//
// Phase 1 — First-class Accounts Receivable domain entity.
//
// Layered on top of JournalEntry (the ledger source of truth).  Each Invoice
// document carries:
//   • lifecycle state (draft → pending_approval → approved → sent → … → paid)
//   • approval workflow metadata (required, threshold, approvers, approval log)
//   • append-only history of field-level edits
//   • soft-delete flag (invoices are NEVER hard-deleted)
//   • linkedJournalEntryId — pointer to the underlying GAAP journal entry
//
// Invariant: state changes are validated against INVOICE_TRANSITIONS in the
// service layer; the model rejects unknown values via enum validation.
//
const mongoose = require('mongoose');
const {
  INVOICE_STATES,
  INVOICE_TRANSITIONS,
  APPROVAL_STATUS,
  APPROVER_ROLES,
  TAX_TYPES,
} = require('../config/constants');

// ── Sub-schemas ───────────────────────────────────────────────────────────────

/** One entry per approval event (submit/approve/reject) — append-only. */
const approvalLogEntrySchema = new mongoose.Schema(
  {
    action:      { type: String, enum: ['submitted', 'approved', 'rejected'], required: true },
    actorId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actorName:   { type: String, required: true },
    actorRole:   { type: String, enum: Object.values(APPROVER_ROLES), default: null },
    note:        { type: String, default: null, maxlength: 500 },
    timestamp:   { type: Date, default: Date.now },
  },
  { _id: false }
);

/** One entry per field-level edit — append-only. */
const fieldChangeSchema = new mongoose.Schema(
  {
    field:     { type: String, required: true },
    before:    { type: mongoose.Schema.Types.Mixed, default: null },
    after:     { type: mongoose.Schema.Types.Mixed, default: null },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/** Lifecycle state-change record — captures who/why for the timeline UI. */
const stateChangeSchema = new mongoose.Schema(
  {
    fromState: { type: String, required: true },
    toState:   { type: String, required: true },
    actorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actorName: { type: String, required: true },
    reason:    { type: String, default: null, maxlength: 500 },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

// ── Phase 2: Line Item sub-schema ────────────────────────────────────────────

const lineItemSchema = new mongoose.Schema(
  {
    // Product / service identification
    itemType:        { type: String, enum: ['product', 'service', 'custom'], default: 'custom' },
    inventoryItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', default: null },
    sku:             { type: String, default: null, trim: true, maxlength: 100 },
    name:            { type: String, required: true, trim: true, maxlength: 300 },
    description:     { type: String, default: null, trim: true, maxlength: 500 },

    // Quantities & pricing
    quantity:  { type: Number, required: true, min: 0.0001 },
    unit:      { type: String, default: 'pcs', trim: true, maxlength: 20 },
    unitPrice: { type: Number, required: true, min: 0 },

    // Line-level discount
    discountType:   { type: String, enum: ['percentage', 'fixed', null], default: null },
    discountValue:  { type: Number, default: 0, min: 0 },
    discountAmount: { type: Number, default: 0, min: 0 }, // computed

    // Line-level tax
    taxType:     { type: String, default: null, maxlength: 30 },
    taxRate:     { type: Number, default: 0, min: 0, max: 100 },
    taxAmount:   { type: Number, default: 0, min: 0 }, // computed
    taxInclusive:{ type: Boolean, default: false },

    // Accounting mapping
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },

    // Computed line total (qty × unitPrice − discount + tax)
    lineTotal: { type: Number, default: 0, min: 0 },

    // Sort order for drag-and-drop
    sortOrder: { type: Number, default: 0 },
  },
  { _id: true } // keep _id so frontend can key rows
);

// ── Phase 2: Attachment sub-schema ───────────────────────────────────────────

const attachmentSchema = new mongoose.Schema(
  {
    fileName:    { type: String, required: true, maxlength: 255 },
    fileUrl:     { type: String, required: true },
    fileType:    { type: String, default: null, maxlength: 50 }, // mime type
    fileSize:    { type: Number, default: null }, // bytes
    uploadedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    uploadedAt:  { type: Date, default: Date.now },
  },
  { _id: true }
);

// ── Main schema ───────────────────────────────────────────────────────────────

const invoiceSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },

    // ── Identification ────────────────────────────────────────────────────────
    invoiceNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
      index: true,
    },

    // ── Link to ledger entry (GAAP source of truth) ──────────────────────────
    // Optional during draft — invoice may exist without a journal posting until approved.
    linkedJournalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
      index: true,
    },

    // ERP Step 4 — the AR-recognition journal posted on approval (DR Accounts
    // Receivable / CR Sales + output tax). Mirrors Bill.apLiabilityJournalId.
    // Its presence marks an invoice-first flow that owns its own AR balance
    // lifecycle (recognition on approve, settlement on markPaid).
    arJournalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
      index: true,
    },

    // ── AR/AP M5 — GL-correct void + credit memos ─────────────────────────────
    voidedAt:           { type: Date, default: null },
    voidReason:         { type: String, default: null, maxlength: 500 },
    voidJournalEntryIds:[{ type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry' }],
    creditMemos: [{
      amount:         { type: Number, required: true, min: 0.01 },
      reason:         { type: String, default: null, maxlength: 500 },
      journalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
      appliedAt:      { type: Date, default: Date.now },
      createdBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    }],

    // ── Customer side (AR) ────────────────────────────────────────────────────
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
    },
    customerSnapshot: {
      // Denormalised copy of customer details at invoice creation time.
      // Protects historic invoices from later customer renames.
      fullName:     { type: String, default: null },
      businessName: { type: String, default: null },
      email:        { type: String, default: null },
      phone:        { type: String, default: null },
      taxId:        { type: String, default: null },
    },

    // ── Phase 2: Line Items ─────────────────────────────────────────────────
    lineItems: [lineItemSchema],

    // ── Money (Phase 1 fields preserved; Phase 2 adds granular totals) ───
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    taxAmount:    { type: Number, default: 0, min: 0 },
    totalAmount:  { type: Number, default: 0, min: 0 },
    currencyCode: { type: String, default: 'PKR', uppercase: true, maxlength: 3 },

    // ── Phase 2: Dynamic Totals ──────────────────────────────────────────
    subtotal:           { type: Number, default: 0, min: 0 }, // sum of line (qty × unitPrice)
    totalLineDiscount:  { type: Number, default: 0, min: 0 }, // sum of per-line discounts
    // Invoice-level discount (applied after line totals)
    invoiceDiscountType:  { type: String, enum: ['percentage', 'fixed', null], default: null },
    invoiceDiscountValue: { type: Number, default: 0, min: 0 },
    invoiceDiscountAmount:{ type: Number, default: 0, min: 0 }, // computed
    totalTax:             { type: Number, default: 0, min: 0 }, // sum of all tax lines
    shippingCharges:      { type: Number, default: 0, min: 0 },
    roundingAdjustment:   { type: Number, default: 0 }, // can be negative
    // totalAmount = subtotal − totalLineDiscount − invoiceDiscount + totalTax + shipping + rounding

    // ── Phase 2: Multi-Currency ──────────────────────────────────────────
    baseCurrencyCode: { type: String, default: 'PKR', uppercase: true, maxlength: 3 },
    exchangeRate:     { type: Number, default: 1, min: 0 },
    baseCurrencyTotal:{ type: Number, default: null }, // totalAmount × exchangeRate

    // ── Phase 2: Attachments ─────────────────────────────────────────────
    attachments: [attachmentSchema],

    // ── Phase 2: Template & PDF ──────────────────────────────────────────
    templateId: { type: String, default: 'modern', maxlength: 50 },
    // Bank details for payment instructions on PDF
    bankDetails: {
      bankName:      { type: String, default: null, maxlength: 100 },
      accountTitle:  { type: String, default: null, maxlength: 100 },
      accountNumber: { type: String, default: null, maxlength: 50 },
      iban:          { type: String, default: null, maxlength: 40 },
      swiftCode:     { type: String, default: null, maxlength: 20 },
      branchCode:    { type: String, default: null, maxlength: 20 },
    },
    // Payment terms text shown on PDF
    paymentTermsText: { type: String, default: null, maxlength: 500, trim: true },

    // ── Phase 2: Credit Note reference ───────────────────────────────────
    creditNoteIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'CreditNote' }],
    totalCredited: { type: Number, default: 0, min: 0 },

    // ── Phase 2.1: Payment reminder history (append-only) ────────────────
    // Records which reminder cadence has already fired for this invoice so
    // the daily cron does not double-send.  Keys mirror paymentReminder.service.
    reminderHistory: [{
      cadenceKey: { type: String, required: true }, // due_in_3 | due_today | overdue_7 | overdue_14 | overdue_30
      firedAt:    { type: Date, default: Date.now },
      channel:    { type: String, default: 'email' }, // email | whatsapp | sms
      to:         { type: String, default: null },
    }],

    // ── Dates ─────────────────────────────────────────────────────────────────
    issueDate: { type: Date, required: true, index: true },
    dueDate:   { type: Date, default: null, index: true },
    sentAt:    { type: Date, default: null },

    // ── Lifecycle state ───────────────────────────────────────────────────────
    state: {
      type: String,
      enum: Object.values(INVOICE_STATES),
      default: INVOICE_STATES.DRAFT,
      index: true,
    },
    stateHistory: [stateChangeSchema],

    // ── Payment tracking (mirror of JournalEntry for fast UI access) ─────────
    paidAmount:       { type: Number, default: 0, min: 0 },
    remainingBalance: { type: Number, default: null, min: 0 },

    // ── Approval workflow ─────────────────────────────────────────────────────
    approvalRequired: { type: Boolean, default: false },
    approvalStatus: {
      type: String,
      enum: Object.values(APPROVAL_STATUS),
      default: APPROVAL_STATUS.NOT_REQUIRED,
    },
    approvalThreshold: { type: Number, default: null }, // amount at which approval kicked in
    approvers: [{
      // Pre-assigned approvers (optional — empty means anyone with role can approve)
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      role:   { type: String, enum: Object.values(APPROVER_ROLES) },
    }],
    approvalLog: [approvalLogEntrySchema],
    // ── AR/AP M6 — multi-level approval chain ─────────────────────────────────
    approvalChain: [{
      sequence:     { type: Number },
      level:        { type: String },
      name:         { type: String },
      requiredRole: { type: String },
      status:       { type: String, default: 'pending' },
      actorId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      actorName:    { type: String, default: null },
      actedAt:      { type: Date, default: null },
      note:         { type: String, default: null },
      history:      { type: [mongoose.Schema.Types.Mixed], default: [] },
    }],
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },

    // ── Audit & history ───────────────────────────────────────────────────────
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    lastModifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    fieldHistory: [fieldChangeSchema],

    // ── Soft delete ───────────────────────────────────────────────────────────
    isArchived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // ── Free-form metadata ────────────────────────────────────────────────────
    description: { type: String, default: null, maxlength: 1000, trim: true },
    notes:       { type: String, default: null, maxlength: 1000, trim: true },
    tags:        [{ type: String, trim: true }],
    metadata:    { type: mongoose.Schema.Types.Mixed, default: {} },

    // ── Dispute / write-off context ───────────────────────────────────────────
    disputeReason: { type: String, default: null, maxlength: 1000 },
    disputedAt:    { type: Date, default: null },
    writeOffReason:{ type: String, default: null, maxlength: 1000 },
    writtenOffAt:  { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => { delete ret.__v; return ret; },
    },
    toObject: { virtuals: true },
  }
);

// ── AR/AP M3 — canonical unified status (derived, never stored) ──────────────
const { deriveUnifiedStatus } = require('../utils/unifiedStatus');
invoiceSchema.virtual('unifiedStatus').get(function () {
  return deriveUnifiedStatus({
    state: this.state, paidAmount: this.paidAmount,
    remainingBalance: this.remainingBalance, totalAmount: this.totalAmount,
  });
});

// ── Indexes ───────────────────────────────────────────────────────────────────
invoiceSchema.index({ businessId: 1, invoiceNumber: 1 }, { unique: true, sparse: true });
invoiceSchema.index({ businessId: 1, state: 1, dueDate: 1 });
invoiceSchema.index({ businessId: 1, customerId: 1, state: 1 });
invoiceSchema.index({ businessId: 1, isArchived: 1, state: 1, createdAt: -1 });
invoiceSchema.index({ businessId: 1, approvalStatus: 1, state: 1 });

// ── Statics ───────────────────────────────────────────────────────────────────

/**
 * Check if a transition from `fromState` to `toState` is permitted.
 * Pure function — no DB access, safe for service-layer guards.
 */
invoiceSchema.statics.canTransition = function (fromState, toState) {
  if (fromState === toState) return true;
  const allowed = INVOICE_TRANSITIONS[fromState];
  return Array.isArray(allowed) && allowed.includes(toState);
};

// ── Instance methods ──────────────────────────────────────────────────────────

/** Append a state change to history. Caller is responsible for setting `state`. */
invoiceSchema.methods.recordStateChange = function (toState, actor, reason = null) {
  this.stateHistory.push({
    fromState: this.state,
    toState,
    actorId:   actor._id,
    actorName: actor.fullName || actor.email || 'Unknown',
    reason,
    timestamp: new Date(),
  });
};

/** Append a field-level change. */
invoiceSchema.methods.recordFieldChange = function (field, before, after, actorId) {
  this.fieldHistory.push({
    field,
    before,
    after,
    changedBy: actorId,
    changedAt: new Date(),
  });
};

// ── Pre-save: compute totals from lineItems (Phase 2) + derive remainingBalance
// ── M4 — cross-field validation (model layer, defense in depth) ─────────────
invoiceSchema.pre('validate', function () {
  if (this.issueDate && this.dueDate && new Date(this.dueDate) < new Date(this.issueDate)) {
    this.invalidate('dueDate', 'dueDate cannot be earlier than issueDate');
  }
});

invoiceSchema.pre('save', function () {
  const r2 = (v) => Math.round(v * 100) / 100;

  if (this.lineItems && this.lineItems.length > 0) {
    // ── Compute per-line values ──────────────────────────────────────
    let subtotal = 0;
    let totalLineDiscount = 0;
    let totalTax = 0;

    for (const li of this.lineItems) {
      const gross = r2(li.quantity * li.unitPrice);

      // Line discount
      let disc = 0;
      if (li.discountType === 'percentage' && li.discountValue > 0) {
        disc = r2(gross * li.discountValue / 100);
      } else if (li.discountType === 'fixed' && li.discountValue > 0) {
        disc = r2(Math.min(li.discountValue, gross));
      }
      li.discountAmount = disc;
      totalLineDiscount += disc;

      const afterDiscount = gross - disc;

      // Line tax
      let tax = 0;
      if (li.taxRate > 0) {
        if (li.taxInclusive) {
          tax = r2(afterDiscount - afterDiscount / (1 + li.taxRate / 100));
        } else {
          tax = r2(afterDiscount * li.taxRate / 100);
        }
      }
      li.taxAmount = tax;
      totalTax += tax;

      // Line total = after discount + tax (exclusive) or just afterDiscount (inclusive — tax already in price)
      li.lineTotal = li.taxInclusive ? r2(afterDiscount) : r2(afterDiscount + tax);
      subtotal += gross;
    }

    this.subtotal = r2(subtotal);
    this.totalLineDiscount = r2(totalLineDiscount);
    this.totalTax = r2(totalTax);

    // Invoice-level discount
    const afterLineDiscounts = r2(subtotal - totalLineDiscount);
    let invoiceDisc = 0;
    if (this.invoiceDiscountType === 'percentage' && this.invoiceDiscountValue > 0) {
      invoiceDisc = r2(afterLineDiscounts * this.invoiceDiscountValue / 100);
    } else if (this.invoiceDiscountType === 'fixed' && this.invoiceDiscountValue > 0) {
      invoiceDisc = r2(Math.min(this.invoiceDiscountValue, afterLineDiscounts));
    }
    this.invoiceDiscountAmount = invoiceDisc;

    // amount = net before tax (backward-compat with Phase 1)
    this.amount = r2(afterLineDiscounts - invoiceDisc);
    this.taxAmount = r2(totalTax);

    // totalAmount = amount + tax + shipping + rounding
    this.totalAmount = r2(
      this.amount + this.taxAmount
      + (this.shippingCharges || 0)
      + (this.roundingAdjustment || 0)
    );
  } else {
    // Legacy path: no line items — derive totalAmount from amount + taxAmount
    if (this.amount != null && this.taxAmount != null) {
      this.totalAmount = r2(this.amount + (this.taxAmount || 0)
        + (this.shippingCharges || 0)
        + (this.roundingAdjustment || 0));
    }
  }

  // Multi-currency: derive base currency total
  if (this.exchangeRate && this.exchangeRate !== 1 && this.totalAmount) {
    this.baseCurrencyTotal = r2(this.totalAmount * this.exchangeRate);
  } else {
    this.baseCurrencyTotal = this.totalAmount;
  }

  // Initialise remainingBalance on first save if not set
  if (this.isNew && (this.remainingBalance === null || this.remainingBalance === undefined)) {
    this.remainingBalance = this.totalAmount;
  }
});

const Invoice = mongoose.model('Invoice', invoiceSchema);
module.exports = Invoice;

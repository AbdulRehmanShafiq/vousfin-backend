// models/Bill.model.js
//
// Phase 1 — First-class Accounts Payable domain entity.
// Phase 3.1 — Extended with 3-Way Match links (PO → GRN → Bill).
//
// Symmetric to Invoice.model.js but on the vendor / AP side.  Each Bill
// document carries:
//   • lifecycle state (draft → awaiting_approval → approved → scheduled → … → paid)
//   • approval workflow metadata (required, threshold, approvers, approval log)
//   • append-only history of field-level edits
//   • soft-delete flag
//   • linkedJournalEntryId — pointer to the underlying GAAP journal entry
//   • purchaseOrderId     — Phase 3.1: the PO this bill was raised against (nullable)
//   • linkedGrnIds        — Phase 3.1: GRNs whose received goods are billed here
//   • threeWayMatchStatus — Phase 3.1: none | pending | matched | discrepancy
//
const mongoose = require('mongoose');
const {
  BILL_STATES,
  BILL_TRANSITIONS,
  APPROVAL_STATUS,
  APPROVER_ROLES,
} = require('../config/constants');

// ── Sub-schemas ───────────────────────────────────────────────────────────────

const approvalLogEntrySchema = new mongoose.Schema(
  {
    action:    { type: String, enum: ['submitted', 'approved', 'rejected'], required: true },
    actorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actorName: { type: String, required: true },
    actorRole: { type: String, enum: Object.values(APPROVER_ROLES), default: null },
    note:      { type: String, default: null, maxlength: 500 },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

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
    itemType:        { type: String, enum: ['product', 'service', 'custom'], default: 'custom' },
    inventoryItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', default: null },
    sku:             { type: String, default: null, trim: true, maxlength: 100 },
    name:            { type: String, required: true, trim: true, maxlength: 300 },
    description:     { type: String, default: null, trim: true, maxlength: 500 },
    quantity:        { type: Number, required: true, min: 0.0001 },
    unit:            { type: String, default: 'pcs', trim: true, maxlength: 20 },
    unitPrice:       { type: Number, required: true, min: 0 },
    discountType:    { type: String, enum: ['percentage', 'fixed', null], default: null },
    discountValue:   { type: Number, default: 0, min: 0 },
    discountAmount:  { type: Number, default: 0, min: 0 },
    taxType:         { type: String, default: null, maxlength: 30 },
    taxRate:         { type: Number, default: 0, min: 0, max: 100 },
    taxAmount:       { type: Number, default: 0, min: 0 },
    taxInclusive:    { type: Boolean, default: false },
    accountId:       { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    lineTotal:       { type: Number, default: 0, min: 0 },
    sortOrder:       { type: Number, default: 0 },
  },
  { _id: true }
);

const attachmentSchema = new mongoose.Schema(
  {
    fileName:   { type: String, required: true, maxlength: 255 },
    fileUrl:    { type: String, required: true },
    fileType:   { type: String, default: null, maxlength: 50 },
    fileSize:   { type: Number, default: null },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

// ── Main schema ───────────────────────────────────────────────────────────────

const billSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },

    billNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
      index: true,
    },

    /**
     * Vendor's external reference number (the number printed on the vendor's
     * invoice when they sent it to us).  Useful for matching incoming bills.
     */
    vendorReferenceNumber: { type: String, default: null, trim: true, maxlength: 100 },

    linkedJournalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
      index: true,
    },

    // ── Phase 3.1: 3-Way Match Links ──────────────────────────────────────────
    // The PO this bill is reconciled against (null = ad-hoc bill with no PO)
    purchaseOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PurchaseOrder',
      default: null,
      index: true,
    },

    // One or more GRNs whose received lines this bill covers (partial deliveries)
    linkedGrnIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'GoodsReceipt' }],

    // 3-way match result: auto-computed when both PO and GRN are linked.
    // Phase 3.2 extended enum — 'discrepancy' kept as legacy alias.
    threeWayMatchStatus: {
      type: String,
      enum: [
        'none', 'pending', 'matched', 'partial_match',
        'over_billed', 'under_received', 'mismatch', 'blocked',
        'discrepancy', // legacy
      ],
      default: 'none',
      index: true,
    },

    // Phase 3.2 — Structured match result stored after running the engine
    matchResult: {
      ranAt:            { type: Date, default: null },
      toleranceConfig:  { type: mongoose.Schema.Types.Mixed, default: null },
      poMatch: {
        status:         { type: String, default: null },
        lineVariances:  { type: [mongoose.Schema.Types.Mixed], default: [] },
        overallStatus:  { type: String, default: null },
      },
      grnMatch: {
        status:         { type: String, default: null },
        totalBilled:    { type: Number, default: null },
        totalReceived:  { type: Number, default: null },
        variance:       { type: Number, default: null },
        variancePct:    { type: Number, default: null },
      },
      duplicateCheck: {
        isDuplicate:    { type: Boolean, default: false },
        conflictingBillId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill', default: null },
        conflictingBillNumber: { type: String, default: null },
      },
      summary:          { type: String, default: null },
    },

    // Phase 3.2 — AP liability journal entry auto-created on bill approval
    apLiabilityJournalId: {
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

    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      default: null,
    },
    vendorSnapshot: {
      vendorName: { type: String, default: null },
      email:      { type: String, default: null },
      phone:      { type: String, default: null },
      taxId:      { type: String, default: null },
      strn:       { type: String, default: null },
    },

    // ── Phase 2: Line Items ─────────────────────────────────────────────
    lineItems: [lineItemSchema],

    amount:       { type: Number, required: true, min: 0.01 },
    taxAmount:    { type: Number, default: 0, min: 0 },
    whtAmount:    { type: Number, default: 0, min: 0 },
    totalAmount:  { type: Number, default: 0, min: 0 },
    currencyCode: { type: String, default: 'PKR', uppercase: true, maxlength: 3 },

    // ── Phase 2: Dynamic Totals ──────────────────────────────────────
    subtotal:              { type: Number, default: 0, min: 0 },
    totalLineDiscount:     { type: Number, default: 0, min: 0 },
    invoiceDiscountType:   { type: String, enum: ['percentage', 'fixed', null], default: null },
    invoiceDiscountValue:  { type: Number, default: 0, min: 0 },
    invoiceDiscountAmount: { type: Number, default: 0, min: 0 },
    totalTax:              { type: Number, default: 0, min: 0 },
    shippingCharges:       { type: Number, default: 0, min: 0 },
    roundingAdjustment:    { type: Number, default: 0 },

    // ── Phase 2: Multi-Currency ──────────────────────────────────────
    baseCurrencyCode:  { type: String, default: 'PKR', uppercase: true, maxlength: 3 },
    exchangeRate:      { type: Number, default: 1, min: 0 },
    baseCurrencyTotal: { type: Number, default: null },

    // ── Phase 2: Attachments ─────────────────────────────────────────
    attachments: [attachmentSchema],

    issueDate:        { type: Date, required: true, index: true },
    dueDate:          { type: Date, default: null, index: true },
    scheduledPayDate: { type: Date, default: null }, // when AP plans to pay this bill

    state: {
      type: String,
      enum: Object.values(BILL_STATES),
      default: BILL_STATES.DRAFT,
      index: true,
    },
    stateHistory: [stateChangeSchema],

    paidAmount:       { type: Number, default: 0, min: 0 },
    remainingBalance: { type: Number, default: null, min: 0 },

    approvalRequired:  { type: Boolean, default: false },
    approvalStatus: {
      type: String,
      enum: Object.values(APPROVAL_STATUS),
      default: APPROVAL_STATUS.NOT_REQUIRED,
    },
    approvalThreshold: { type: Number, default: null },
    approvers: [{
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
    approvedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt:  { type: Date, default: null },

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

    isArchived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    description: { type: String, default: null, maxlength: 1000, trim: true },
    notes:       { type: String, default: null, maxlength: 1000, trim: true },
    tags:        [{ type: String, trim: true }],
    metadata:    { type: mongoose.Schema.Types.Mixed, default: {} },

    // ── Phase 3.3 — Document Management ──────────────────────────────────────
    documentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'BillDocument' }],

    // ── Phase 3.3 — Bill Scheduling / Recurring ───────────────────────────────
    isRecurring: { type: Boolean, default: false, index: true },
    scheduleId:  { type: mongoose.Schema.Types.ObjectId, ref: 'BillSchedule', default: null, index: true },

    // ── Phase 3.3 — Reminder State ────────────────────────────────────────────
    reminderState: {
      type: String,
      enum: ['upcoming', 'due_today', 'overdue', 'critical_overdue', null],
      default: null,
      index: true,
    },
    reminderSentAt: { type: Date, default: null },

    // ── Phase 3.3 — Expense Allocation ────────────────────────────────────────
    // allocationId is set once an allocation record is created for this bill
    allocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'BillAllocation', default: null },
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
billSchema.virtual('unifiedStatus').get(function () {
  return deriveUnifiedStatus({
    state: this.state, paidAmount: this.paidAmount,
    remainingBalance: this.remainingBalance, totalAmount: this.totalAmount,
  });
});

// ── Indexes ───────────────────────────────────────────────────────────────────
billSchema.index({ businessId: 1, billNumber: 1 }, { unique: true, sparse: true });
billSchema.index({ businessId: 1, state: 1, dueDate: 1 });
billSchema.index({ businessId: 1, vendorId: 1, state: 1 });
billSchema.index({ businessId: 1, isArchived: 1, state: 1, createdAt: -1 });
billSchema.index({ businessId: 1, approvalStatus: 1, state: 1 });
// Phase 3.1 — 3-Way Match query patterns
billSchema.index({ businessId: 1, purchaseOrderId: 1 });
billSchema.index({ businessId: 1, threeWayMatchStatus: 1, state: 1 });

// ── Statics ───────────────────────────────────────────────────────────────────
billSchema.statics.canTransition = function (fromState, toState) {
  if (fromState === toState) return true;
  const allowed = BILL_TRANSITIONS[fromState];
  return Array.isArray(allowed) && allowed.includes(toState);
};

// ── Instance methods ──────────────────────────────────────────────────────────
billSchema.methods.recordStateChange = function (toState, actor, reason = null) {
  this.stateHistory.push({
    fromState: this.state,
    toState,
    actorId:   actor._id,
    actorName: actor.fullName || actor.email || 'Unknown',
    reason,
    timestamp: new Date(),
  });
};

billSchema.methods.recordFieldChange = function (field, before, after, actorId) {
  this.fieldHistory.push({ field, before, after, changedBy: actorId, changedAt: new Date() });
};

// ── Pre-save: compute totals from lineItems (Phase 2) ────────────────────────
// ── M4 — cross-field validation (model layer, defense in depth) ─────────────
billSchema.pre('validate', function () {
  if (this.issueDate && this.dueDate && new Date(this.dueDate) < new Date(this.issueDate)) {
    this.invalidate('dueDate', 'dueDate cannot be earlier than issueDate');
  }
});

billSchema.pre('save', function () {
  const r2 = (v) => Math.round(v * 100) / 100;

  if (this.lineItems && this.lineItems.length > 0) {
    let subtotal = 0, totalLineDiscount = 0, totalTax = 0;
    for (const li of this.lineItems) {
      const gross = r2(li.quantity * li.unitPrice);
      let disc = 0;
      if (li.discountType === 'percentage' && li.discountValue > 0) {
        disc = r2(gross * li.discountValue / 100);
      } else if (li.discountType === 'fixed' && li.discountValue > 0) {
        disc = r2(Math.min(li.discountValue, gross));
      }
      li.discountAmount = disc;
      totalLineDiscount += disc;
      const afterDiscount = gross - disc;
      let tax = 0;
      if (li.taxRate > 0) {
        tax = li.taxInclusive
          ? r2(afterDiscount - afterDiscount / (1 + li.taxRate / 100))
          : r2(afterDiscount * li.taxRate / 100);
      }
      li.taxAmount = tax;
      totalTax += tax;
      li.lineTotal = li.taxInclusive ? r2(afterDiscount) : r2(afterDiscount + tax);
      subtotal += gross;
    }
    this.subtotal = r2(subtotal);
    this.totalLineDiscount = r2(totalLineDiscount);
    this.totalTax = r2(totalTax);

    const afterLineDiscounts = r2(subtotal - totalLineDiscount);
    let invoiceDisc = 0;
    if (this.invoiceDiscountType === 'percentage' && this.invoiceDiscountValue > 0) {
      invoiceDisc = r2(afterLineDiscounts * this.invoiceDiscountValue / 100);
    } else if (this.invoiceDiscountType === 'fixed' && this.invoiceDiscountValue > 0) {
      invoiceDisc = r2(Math.min(this.invoiceDiscountValue, afterLineDiscounts));
    }
    this.invoiceDiscountAmount = invoiceDisc;
    this.amount = r2(afterLineDiscounts - invoiceDisc);
    this.taxAmount = r2(totalTax);
    this.totalAmount = r2(this.amount + this.taxAmount + (this.shippingCharges || 0) + (this.roundingAdjustment || 0));
  } else {
    if (this.amount != null && this.taxAmount != null) {
      this.totalAmount = r2(this.amount + (this.taxAmount || 0) + (this.shippingCharges || 0) + (this.roundingAdjustment || 0));
    }
  }

  if (this.exchangeRate && this.exchangeRate !== 1 && this.totalAmount) {
    this.baseCurrencyTotal = r2(this.totalAmount * this.exchangeRate);
  } else {
    this.baseCurrencyTotal = this.totalAmount;
  }

  if (this.isNew && (this.remainingBalance === null || this.remainingBalance === undefined)) {
    this.remainingBalance = this.totalAmount;
  }
});

const Bill = mongoose.model('Bill', billSchema);
module.exports = Bill;

// validations/transaction.validation.js
const Joi = require('joi');
const { TRANSACTION_TYPES, INPUT_METHODS, JOURNAL_STATUS, PAYMENT_STATUS, TRANSACTION_MODES, TRANSACTION_CATEGORIES } = require('../config/constants');

const objectIdPattern = /^[0-9a-fA-F]{24}$/;

/**
 * Journal line validation for future compound entries
 */
const journalLineSchema = Joi.object({
  accountId: Joi.string().pattern(objectIdPattern).required(),
  type: Joi.string().valid('debit', 'credit').required(),
  amount: Joi.number().positive().max(999_999_999_999).precision(2).required(),
  description: Joi.string().max(200).allow('', null).optional(),
  // SRS FR-07.1 — optional per-line cost/profit-centre tag.
  costCenterId: Joi.string().pattern(objectIdPattern).allow(null, '').optional(),
});

/**
 * Schema for creating a transaction via structured form.
 * Updated for v2 to support AR/AP, Installments, and new transaction modes.
 */
const createTransactionSchema = Joi.object({
  // Core Fields
  transactionDate: Joi.date().iso().required(),
  description: Joi.string().min(3).max(500).required().trim(),
  transactionType: Joi.string().valid(...Object.values(TRANSACTION_TYPES)).optional(),
  transactionMode: Joi.string().valid(...Object.values(TRANSACTION_MODES)).optional(),
  // Cap at 1 trillion to prevent float-precision loss and catch obvious data-entry errors.
  // Optional when journalLines provided — the custom validator below auto-computes amount
  // from the debit total so callers don't need to pre-calculate it.
  amount: Joi.when('journalLines', {
    is:        Joi.array().min(1).required(),
    then:      Joi.number().positive().max(999_999_999_999).precision(2).optional(),
    otherwise: Joi.number().positive().max(999_999_999_999).precision(2).required(),
  }),

  // Account IDs (Required for backward compatibility)
  debitAccountId: Joi.string().pattern(objectIdPattern).required(),
  creditAccountId: Joi.string().pattern(objectIdPattern).required(),

  // Party References (AR/AP) — ID or plain name; backend resolves/auto-creates
  customerId: Joi.string().pattern(objectIdPattern).allow(null).optional(),
  vendorId: Joi.string().pattern(objectIdPattern).allow(null).optional(),
  customerName: Joi.string().max(150).trim().allow('', null).optional(),
  vendorName: Joi.string().max(150).trim().allow('', null).optional(),

  // Payment Tracking
  dueDate: Joi.date().iso().allow(null).optional(),
  paymentTerms: Joi.string().max(100).allow('', null).trim().optional(),

  // Transaction Relationships
  parentTransactionId: Joi.string().pattern(objectIdPattern).allow(null).optional(),

  // Metadata
  transactionReference: Joi.string().max(100).allow('', null).trim().optional(),
  invoiceNumber:        Joi.string().max(50).allow('', null).trim().optional(),   // ← ADDED: invoice/bill ref
  paymentMethod:        Joi.string().valid('cash','bank','credit_card','debit_card','cheque','mobile_wallet','online').allow('', null).trim().optional(),
  transactionCategory: Joi.string().valid(...Object.values(TRANSACTION_CATEGORIES)).allow(null).optional(),
  notes: Joi.string().max(1000).allow('', null).trim().optional(),
  tags: Joi.array().items(Joi.string().trim()).optional(),
  attachmentUrls: Joi.array().items(Joi.string()).optional(),

  // Multi-Currency (Phase 5.3)
  currencyCode:  Joi.string().length(3).uppercase().allow(null, '').optional(),
  exchangeRate:  Joi.number().positive().allow(null).optional(),  // null when field cleared

  // Tax Engine (Phase 5.4) — all optional; backend auto-calculates when tax is enabled
  taxAmount:        Joi.number().min(0).precision(2).allow(null).optional(),
  taxRate:          Joi.number().min(0).max(100).allow(null).optional(),
  taxType:          Joi.string().max(30).uppercase().allow(null, '').optional(),
  taxInclusive:     Joi.boolean().allow(null).optional(),
  skipTax:          Joi.boolean().optional(),           // explicitly disable auto-tax for this txn
  isReverseCharge:  Joi.boolean().optional(),           // AE/SA/IN reverse charge
  isImportedService:Joi.boolean().optional(),           // RC trigger: supplier is outside country
  whtCategory:      Joi.string().max(50).allow(null, '').optional(),  // e.g. 'services_company'
  whtApply:         Joi.boolean().optional(),           // explicitly enable WHT on this transaction

  // Compound Entry Support (Optional)
  journalLines: Joi.array().items(journalLineSchema).optional(),

  // Inventory (Phase 3.5) — set when an inventory item is linked to a sale/purchase
  inventoryItemId: Joi.string().pattern(objectIdPattern).allow(null, '').optional(),
  inventoryQty:    Joi.number().min(0).allow(null).optional(),
  // SRS FR-07.1 — optional entry-level cost/profit-centre tag.
  costCenterId:    Joi.string().pattern(objectIdPattern).allow(null, '').optional(),
}).custom((value, helpers) => {
  // Validate Debit != Credit
  if (value.debitAccountId === value.creditAccountId) {
    return helpers.error('any.invalid', { message: 'Debit and credit accounts must be different' });
  }

  // Conditional Logic: Payments require a parent transaction
  if ((value.transactionType === TRANSACTION_TYPES.PAYMENT_RECEIVED || value.transactionType === TRANSACTION_TYPES.PAYMENT_MADE) && value.transactionMode === TRANSACTION_MODES.PARTIAL_SETTLEMENT) {
    if (!value.parentTransactionId) {
      return helpers.message('Settlement payments require a parentTransactionId');
    }
  }

  // Multi-line journal validation: Debits must equal Credits
  if (value.journalLines && value.journalLines.length > 0) {
    let debits = 0;
    let credits = 0;
    value.journalLines.forEach(line => {
      if (line.type === 'debit') debits += line.amount;
      if (line.type === 'credit') credits += line.amount;
    });
    // Use Math.round to avoid floating point precision issues
    if (Math.round(debits * 100) !== Math.round(credits * 100)) {
      return helpers.message('Total debits must equal total credits in journal lines');
    }
    // Auto-compute amount from journal lines — the debit total IS the transaction amount.
    // This removes the requirement for the caller to pre-calculate and pass amount separately,
    // which was non-intuitive for compound entries (e.g. asset disposal where multiple
    // debit accounts sum to more than the asset's original cost).
    if (debits > 0) {
      value.amount = Math.round(debits * 100) / 100;
    }
  }

  return value;
});

/**
 * #9 — Schema for server-side batch posting.
 * Each item carries the core transaction fields (the engine fills in the rest);
 * unknown keys (party names, currency, tax flags…) are allowed through.
 */
const batchTransactionsSchema = Joi.object({
  items: Joi.array().min(1).max(1000).required().items(
    Joi.object({
      transactionDate: Joi.date().iso().required(),
      description:     Joi.string().min(1).max(500).required(),
      amount:          Joi.number().positive().required(),
      debitAccountId:  Joi.string().pattern(objectIdPattern).required(),
      creditAccountId: Joi.string().pattern(objectIdPattern).required(),
      idempotencyKey:  Joi.string().max(120).optional(),
    }).unknown(true)
  ),
});

/**
 * Schema for editing a transaction.
 */
const updateTransactionSchema = Joi.object({
  transactionDate: Joi.date().iso().optional(),
  description: Joi.string().min(3).max(500).trim().optional(),
  transactionType: Joi.string().valid(...Object.values(TRANSACTION_TYPES)).optional(),
  amount: Joi.number().positive().precision(2).optional(),
  debitAccountId: Joi.string().pattern(objectIdPattern).optional(),
  creditAccountId: Joi.string().pattern(objectIdPattern).optional(),
  
  customerId: Joi.string().pattern(objectIdPattern).allow(null).optional(),
  vendorId: Joi.string().pattern(objectIdPattern).allow(null).optional(),
  dueDate: Joi.date().iso().allow(null).optional(),
  paymentTerms: Joi.string().max(100).allow('', null).trim().optional(),
  notes: Joi.string().max(1000).allow('', null).trim().optional(),
  tags: Joi.array().items(Joi.string().trim()).optional(),
}).min(1);

/**
 * Schema for recording a partial payment (settlement engine)
 */
const recordPaymentSchema = Joi.object({
  parentTransactionId: Joi.string().pattern(objectIdPattern).required(),
  amount: Joi.number().positive().precision(2).required(),
  transactionDate: Joi.date().iso().required(),
  paymentAccountId: Joi.string().pattern(objectIdPattern).required(),
  description: Joi.string().max(500).allow('', null).trim().optional(),
  reference: Joi.string().max(100).allow('', null).trim().optional(),
});

/**
 * Schema for creating an installment plan (structured form — POST /installment)
 *
 * Extends the full createTransactionSchema so every optional field the form
 * might send (invoiceNumber, paymentMethod, taxes, customerName, notes …)
 * is accepted without a "Validation failed" rejection.  The controller only
 * reads the plan-specific fields it needs; everything else passes through.
 */
const createInstallmentSchema = createTransactionSchema.keys({
  // Installment plan fields (required)
  // Note: integer().min(1) is lenient — coerces string "12" → 12 automatically
  installmentCount:     Joi.number().integer().min(1).max(120).required(),
  installmentFrequency: Joi.string().valid('weekly', 'biweekly', 'monthly', 'quarterly').required(),

  // Installment plan fields (optional)
  // allow(null) is required: react-hook-form valueAsNumber returns NaN for empty inputs;
  // JSON.stringify converts NaN → null, so the backend receives null for cleared fields.
  downPayment:          Joi.number().min(0).precision(2).allow(null).default(0),
  interestRate:         Joi.number().min(0).max(100).allow(null).optional(),
  interestMethod:       Joi.string().valid('reducing_balance', 'flat').allow(null, '').optional(),
  firstPaymentDate:     Joi.date().iso().allow(null, '').optional(),
});

/**
 * NL parse schema
 */
const naturalLanguageSchema = Joi.object({
  text: Joi.string().min(5).max(500).required().trim(),
  // Clarification round counter — the frontend bumps this each time it re-parses
  // after the user answers a follow-up question. Capped so parsing always ends.
  attempt: Joi.number().integer().min(0).max(5).optional(),
});

/**
 * NL image (photo/receipt) parse schema — Phase 1 of the transaction-entry
 * upgrade. `image` is a raw base64 payload (no data: URI prefix); the client
 * downscales to ~1600px before sending so this stays well under the app's
 * 10mb JSON body limit.
 */
const naturalLanguageImageSchema = Joi.object({
  image: Joi.string().min(100).required(),
  mimeType: Joi.string().valid('image/jpeg', 'image/png', 'image/webp', 'image/heic').optional(),
  attempt: Joi.number().integer().min(0).max(5).optional(),
});

/**
 * NL confirm schema — extends the base transaction schema with installment / financing
 * fields that the NL preview step may forward back (Phase 3).
 *
 * Previously this was an alias for createTransactionSchema which caused Joi to reject
 * isInstallment / installmentCount / downPayment / installmentFrequency /
 * installmentPeriodMonths / interestRate as unknown keys → "Validation failed" toast.
 */
const confirmNaturalLanguageSchema = createTransactionSchema.keys({
  // Installment routing (Phase 3)
  isInstallment:           Joi.boolean().optional(),
  installmentCount:        Joi.number().integer().min(1).max(120).optional(),
  installmentFrequency:    Joi.string().valid('weekly', 'biweekly', 'monthly', 'quarterly').optional(),
  downPayment:             Joi.number().min(0).precision(2).optional(),
  installmentPeriodMonths: Joi.number().integer().min(1).max(120).optional(),

  // Interest / financing (Phase 3)
  interestRate:            Joi.number().min(0).max(100).optional(),
});

/**
 * Legacy Excel schemas
 */
const excelUploadSchema = Joi.object({}).optional();

const confirmExcelImportSchema = Joi.object({
  columnMapping: Joi.object().optional(),
  rows: Joi.array().items(
    Joi.object({
      date: Joi.date().iso().required(),
      description: Joi.string().min(3).max(500).required(),
      transactionType: Joi.string().valid(...Object.values(TRANSACTION_TYPES)).required(),
      amount: Joi.number().positive().precision(2).required(),
      debitAccountName: Joi.string().required(),
      creditAccountName: Joi.string().required(),
      originalRow: Joi.number().required(),
    }).unknown(true) // allow other fields for future proofing
  ).min(1).required(),
});

/**
 * Query filters and pagination for listing transactions.
 */
const transactionFiltersSchema = Joi.object({
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  transactionType: Joi.string().valid(...Object.values(TRANSACTION_TYPES)).optional(),
  minAmount: Joi.number().positive().optional(),
  maxAmount: Joi.number().positive().optional(),
  accountId: Joi.string().pattern(objectIdPattern).optional(),
  customerId: Joi.string().pattern(objectIdPattern).optional(),
  vendorId: Joi.string().pattern(objectIdPattern).optional(),
  status: Joi.string().valid(...Object.values(JOURNAL_STATUS)).optional(),
  paymentStatus: Joi.string().valid(...Object.values(PAYMENT_STATUS)).optional(),
  hasOutstandingBalance: Joi.boolean().optional(),
  search: Joi.string().max(100).optional().allow(''),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(500).default(50),
  sortBy: Joi.string().valid('transactionDate', 'amount', 'createdAt', 'updatedAt', 'dueDate').default('transactionDate'),
  sortOrder: Joi.number().valid(1, -1).default(-1),
}).custom((value, helpers) => {
  if (value.startDate && value.endDate && new Date(value.startDate) > new Date(value.endDate)) {
    return helpers.error('date.greater', { message: 'Start date cannot be after end date' });
  }
  if (value.minAmount && value.maxAmount && value.minAmount > value.maxAmount) {
    return helpers.error('any.invalid', { message: 'Minimum amount cannot be greater than maximum amount' });
  }
  return value;
});

const transactionIdParamSchema = Joi.object({
  id: Joi.string().pattern(objectIdPattern).required(),
});

/**
 * Schema for reversing a posted transaction.
 * POST /transactions/:id/reverse
 */
const reverseTransactionSchema = Joi.object({
  reversalDate: Joi.date().iso().allow(null).optional(),
  reason:       Joi.string().max(500).allow('', null).trim().optional(),
});

module.exports = {
  createTransactionSchema,
  updateTransactionSchema,
  recordPaymentSchema,
  createInstallmentSchema,
  naturalLanguageSchema,
  naturalLanguageImageSchema,
  confirmNaturalLanguageSchema,
  excelUploadSchema,
  confirmExcelImportSchema,
  batchTransactionsSchema,
  transactionFiltersSchema,
  transactionIdParamSchema,
  reverseTransactionSchema,
};
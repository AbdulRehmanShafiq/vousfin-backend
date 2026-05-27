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
  amount: Joi.number().positive().precision(2).required(),
  description: Joi.string().max(200).allow('', null).optional(),
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
  amount: Joi.number().positive().precision(2).required(),
  
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
  transactionCategory: Joi.string().valid(...Object.values(TRANSACTION_CATEGORIES)).allow(null).optional(),
  notes: Joi.string().max(1000).allow('', null).trim().optional(),
  tags: Joi.array().items(Joi.string().trim()).optional(),
  attachmentUrls: Joi.array().items(Joi.string()).optional(),

  // Multi-Currency (Phase 5.3)
  currencyCode:  Joi.string().length(3).uppercase().allow(null, '').optional(),
  exchangeRate:  Joi.number().positive().optional(),

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
    if (Math.round(debits * 100) !== Math.round(value.amount * 100)) {
      return helpers.message('Journal line total must equal the primary transaction amount');
    }
  }

  return value;
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
 */
const createInstallmentSchema = Joi.object({
  // Transaction part
  transactionDate: Joi.date().iso().required(),
  description: Joi.string().min(3).max(500).required().trim(),
  amount: Joi.number().positive().precision(2).required(),
  debitAccountId: Joi.string().pattern(objectIdPattern).required(),
  creditAccountId: Joi.string().pattern(objectIdPattern).required(),

  customerId: Joi.string().pattern(objectIdPattern).allow(null).optional(),
  vendorId: Joi.string().pattern(objectIdPattern).allow(null).optional(),

  // Plan part
  downPayment: Joi.number().min(0).precision(2).default(0),
  installmentCount: Joi.number().integer().min(1).max(120).required(),
  installmentFrequency: Joi.string().valid('weekly', 'biweekly', 'monthly', 'quarterly').required(),

  // Interest / financing (Phase 3)
  interestRate: Joi.number().min(0).max(100).optional(),
});

/**
 * NL parse schema
 */
const naturalLanguageSchema = Joi.object({
  text: Joi.string().min(5).max(500).required().trim(),
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
  confirmNaturalLanguageSchema,
  excelUploadSchema,
  confirmExcelImportSchema,
  transactionFiltersSchema,
  transactionIdParamSchema,
  reverseTransactionSchema,
};
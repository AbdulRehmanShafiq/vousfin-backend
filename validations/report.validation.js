// validations/report.validation.js
const Joi = require('joi');

const isoDate = () =>
  Joi.date().iso().messages({
    'date.base': 'Must be a valid date',
    'date.iso':  'Must be in ISO format (YYYY-MM-DD)',
  });

const dateRangeValidation = (value, helpers) => {
  if (value.startDate && value.endDate && new Date(value.startDate) > new Date(value.endDate))
    return helpers.error('date.greater', { message: 'startDate cannot be after endDate' });
  return value;
};

// ─── Income Statement ─────────────────────────────────────────────────────────
const incomeStatementSchema = Joi.object({
  startDate: isoDate().required().messages({ 'any.required': 'startDate is required' }),
  endDate:   isoDate().required().messages({ 'any.required': 'endDate is required'   }),
}).custom(dateRangeValidation);

// ─── Balance Sheet ────────────────────────────────────────────────────────────
const balanceSheetSchema = Joi.object({
  asOfDate:    isoDate().required().messages({ 'any.required': 'asOfDate is required' }),
  compareDate: isoDate().optional(),
});

// ─── Cash Flow ────────────────────────────────────────────────────────────────
const cashFlowSchema = Joi.object({
  startDate: isoDate().required(),
  endDate:   isoDate().required(),
}).custom(dateRangeValidation);

// ─── Trial Balance ────────────────────────────────────────────────────────────
const trialBalanceSchema = Joi.object({
  asOfDate: isoDate().required().messages({ 'any.required': 'asOfDate is required' }),
  fromDate: isoDate().optional(),
});

// ─── General Ledger ───────────────────────────────────────────────────────────
const generalLedgerSchema = Joi.object({
  startDate: isoDate().required(),
  endDate:   isoDate().required(),
  accountId: Joi.string().hex().length(24).optional(),
}).custom(dateRangeValidation);

// ─── Aging Report ─────────────────────────────────────────────────────────────
const agingReportSchema = Joi.object({
  type: Joi.string().valid('receivable', 'payable').required()
    .messages({ 'any.only': 'type must be "receivable" or "payable"', 'any.required': 'type is required' }),
});

// ─── Liability Report ─────────────────────────────────────────────────────────
const liabilityReportSchema = Joi.object({
  asOfDate: isoDate().optional(),
});

// ─── Comparative Reports ──────────────────────────────────────────────────────
const comparativeIncomeSchema = Joi.object({
  currentStart: isoDate().required(),
  currentEnd:   isoDate().required(),
  priorStart:   isoDate().required(),
  priorEnd:     isoDate().required(),
}).custom((value, helpers) => {
  if (new Date(value.currentStart) > new Date(value.currentEnd))
    return helpers.error('date.greater', { message: 'currentStart cannot be after currentEnd' });
  if (new Date(value.priorStart) > new Date(value.priorEnd))
    return helpers.error('date.greater', { message: 'priorStart cannot be after priorEnd' });
  return value;
});

const comparativeBalanceSchema = Joi.object({
  currentDate: isoDate().required(),
  priorDate:   isoDate().required(),
});

// ─── KPI ──────────────────────────────────────────────────────────────────────
const kpiSchema = Joi.object({
  startDate: isoDate().optional(),
  endDate:   isoDate().optional(),
}).custom(dateRangeValidation);

// ─── Export ───────────────────────────────────────────────────────────────────
const exportReportSchema = Joi.object({
  type: Joi.string()
    .valid('incomeStatement', 'balanceSheet', 'cashFlow', 'trialBalance', 'generalLedger', 'aging')
    .required()
    .messages({
      'any.only':     'type must be one of: incomeStatement, balanceSheet, cashFlow, trialBalance, generalLedger, aging',
      'any.required': 'type is required',
    }),
  format: Joi.string().valid('pdf', 'xlsx').required()
    .messages({ 'any.only': 'format must be pdf or xlsx', 'any.required': 'format is required' }),
  startDate:  Joi.when('type', {
    is: Joi.string().valid('incomeStatement', 'cashFlow', 'generalLedger'),
    then: isoDate().required(), otherwise: Joi.optional(),
  }),
  endDate:    Joi.when('type', {
    is: Joi.string().valid('incomeStatement', 'cashFlow', 'generalLedger'),
    then: isoDate().required(), otherwise: Joi.optional(),
  }),
  asOfDate:   Joi.when('type', {
    is: Joi.string().valid('balanceSheet', 'trialBalance'),
    then: isoDate().required(), otherwise: Joi.optional(),
  }),
  agingType:  Joi.when('type', {
    is: 'aging',
    then: Joi.string().valid('receivable', 'payable').default('receivable'),
    otherwise: Joi.optional(),
  }),
  accountId:  Joi.string().hex().length(24).optional(),
}).custom((value, helpers) => {
  const rangeTypes = ['incomeStatement', 'cashFlow', 'generalLedger'];
  if (rangeTypes.includes(value.type) && value.startDate && value.endDate) {
    if (new Date(value.startDate) > new Date(value.endDate))
      return helpers.error('date.greater', { message: 'startDate cannot be after endDate' });
  }
  return value;
});

module.exports = {
  incomeStatementSchema,
  balanceSheetSchema,
  cashFlowSchema,
  trialBalanceSchema,
  generalLedgerSchema,
  agingReportSchema,
  liabilityReportSchema,
  comparativeIncomeSchema,
  comparativeBalanceSchema,
  kpiSchema,
  exportReportSchema,
};

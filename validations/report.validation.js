// validations/report.validation.js
const Joi = require('joi');

/**
 * Common date range validation helper.
 * Ensures startDate <= endDate if both provided.
 */
const dateRangeValidation = (value, helpers) => {
  if (value.startDate && value.endDate) {
    const start = new Date(value.startDate);
    const end = new Date(value.endDate);
    if (start > end) {
      return helpers.error('date.greater', { message: 'Start date cannot be after end date' });
    }
  }
  return value;
};

/**
 * Schema for Income Statement generation.
 */
const incomeStatementSchema = Joi.object({
  startDate: Joi.date().iso().required().messages({
    'date.base': 'startDate must be a valid date',
    'date.iso': 'startDate must be in ISO format (YYYY-MM-DD)',
    'any.required': 'startDate is required',
  }),
  endDate: Joi.date().iso().required().messages({
    'date.base': 'endDate must be a valid date',
    'date.iso': 'endDate must be in ISO format (YYYY-MM-DD)',
    'any.required': 'endDate is required',
  }),
}).custom(dateRangeValidation);

/**
 * Schema for Balance Sheet generation.
 */
const balanceSheetSchema = Joi.object({
  asOfDate: Joi.date().iso().required().messages({
    'date.base': 'asOfDate must be a valid date',
    'date.iso': 'asOfDate must be in ISO format (YYYY-MM-DD)',
    'any.required': 'asOfDate is required',
  }),
});

/**
 * Schema for Cash Flow Statement generation.
 */
const cashFlowSchema = Joi.object({
  startDate: Joi.date().iso().required(),
  endDate: Joi.date().iso().required(),
}).custom(dateRangeValidation);

/**
 * Schema for KPI dashboard data (optional date range).
 */
const kpiSchema = Joi.object({
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
}).custom(dateRangeValidation);

/**
 * Schema for export requests.
 */
const exportReportSchema = Joi.object({
  type: Joi.string().valid('incomeStatement', 'balanceSheet', 'cashFlow').required().messages({
    'any.only': 'Report type must be one of: incomeStatement, balanceSheet, cashFlow',
    'any.required': 'Report type is required',
  }),
  format: Joi.string().valid('pdf', 'xlsx').required().messages({
    'any.only': 'Format must be either pdf or xlsx',
    'any.required': 'Export format is required',
  }),
  startDate: Joi.when('type', {
    is: Joi.string().valid('incomeStatement', 'cashFlow'),
    then: Joi.date().iso().required(),
    otherwise: Joi.optional(),
  }),
  endDate: Joi.when('type', {
    is: Joi.string().valid('incomeStatement', 'cashFlow'),
    then: Joi.date().iso().required(),
    otherwise: Joi.optional(),
  }),
  asOfDate: Joi.when('type', {
    is: 'balanceSheet',
    then: Joi.date().iso().required(),
    otherwise: Joi.optional(),
  }),
}).custom((value, helpers) => {
  if (value.type === 'incomeStatement' || value.type === 'cashFlow') {
    if (value.startDate && value.endDate && new Date(value.startDate) > new Date(value.endDate)) {
      return helpers.error('date.greater', { message: 'Start date cannot be after end date' });
    }
  }
  return value;
});

/**
 * Schema for Trial Balance report.
 */
const trialBalanceSchema = Joi.object({
  asOfDate: Joi.date().iso().required().messages({
    'date.base': 'asOfDate must be a valid date',
    'any.required': 'asOfDate is required',
  }),
});

module.exports = {
  incomeStatementSchema,
  balanceSheetSchema,
  cashFlowSchema,
  kpiSchema,
  exportReportSchema,
  trialBalanceSchema,
};

// validations/business.validation.js
const Joi = require('joi');
const { BUSINESS_TYPES, DEFAULT_CURRENCY, ACCOUNT_TYPES, NORMAL_BALANCE } = require('../config/constants');

/**
 * Schema for creating a new business profile.
 * Used in POST /business
 */
const createBusinessSchema = Joi.object({
  businessName: Joi.string().min(2).max(100).required().trim().messages({
    'string.min': 'Business name must be at least 2 characters',
    'string.max': 'Business name cannot exceed 100 characters',
    'any.required': 'Business name is required',
  }),
  registrationNumber: Joi.string().max(100).allow('', null).trim().optional().messages({
    'string.max': 'Registration number cannot exceed 100 characters',
  }),
  businessType: Joi.string().valid(...BUSINESS_TYPES).required().messages({
    'any.only': `Business type must be one of: ${BUSINESS_TYPES.join(', ')}`,
    'any.required': 'Business type is required',
  }),
  currency: Joi.string().length(3).uppercase().default(DEFAULT_CURRENCY).optional().messages({
    'string.length': 'Currency must be a 3-letter ISO code (e.g., PKR, USD)',
  }),
  fiscalYearStartMonth: Joi.number().integer().min(1).max(12).default(1).optional(),
  logoUrl: Joi.string().uri().optional().allow('', null).messages({
    'string.uri': 'Logo URL must be a valid URL',
  }),
});

/**
 * Schema for updating business settings.
 * Used in PUT /business
 * All fields are optional, but at least one must be provided.
 */
const updateBusinessSchema = Joi.object({
  businessName: Joi.string().min(2).max(100).trim().optional(),
  registrationNumber: Joi.string().max(100).allow('', null).trim().optional(),
  businessType: Joi.string().valid(...BUSINESS_TYPES).optional(),
  currency: Joi.string().length(3).uppercase().optional(),
  fiscalYearStartMonth: Joi.number().integer().min(1).max(12).optional(),
  logoUrl: Joi.string().uri().allow('', null).optional(),
}).min(1); // at least one field must be present

/**
 * Schema for adding a custom chart of accounts (optional feature).
 * Used in POST /business/accounts
 */
const addCustomAccountSchema = Joi.object({
  accountName: Joi.string().min(2).max(100).required().trim().messages({
    'string.min': 'Account name must be at least 2 characters',
    'any.required': 'Account name is required',
  }),
  accountType: Joi.string().valid(...Object.values(ACCOUNT_TYPES)).required().messages({
    'any.only': `Account type must be one of: ${Object.values(ACCOUNT_TYPES).join(', ')}`,
    'any.required': 'Account type is required',
  }),
  normalBalance: Joi.string().valid(...Object.values(NORMAL_BALANCE)).required().messages({
    'any.only': `Normal balance must be one of: ${Object.values(NORMAL_BALANCE).join(', ')}`,
    'any.required': 'Normal balance is required',
  }),
});

/**
 * Schema for updating an existing account (optional).
 * Used in PUT /business/accounts/:accountId
 */
const updateAccountSchema = Joi.object({
  accountName: Joi.string().min(2).max(100).trim().optional(),
  accountType: Joi.string().valid(...Object.values(ACCOUNT_TYPES)).optional(),
  normalBalance: Joi.string().valid(...Object.values(NORMAL_BALANCE)).optional(),
}).min(1);

/**
 * Schema for listing accounts (query parameters).
 * Used in GET /business/accounts
 */
const listAccountsQuerySchema = Joi.object({
  accountType: Joi.string().valid(...Object.values(ACCOUNT_TYPES)).optional(),
  page: Joi.number().integer().min(1).default(1).optional(),
  limit: Joi.number().integer().min(1).max(100).default(25).optional(),
});

module.exports = {
  createBusinessSchema,
  updateBusinessSchema,
  addCustomAccountSchema,
  updateAccountSchema,
  listAccountsQuerySchema,
};
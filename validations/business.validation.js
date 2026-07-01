// validations/business.validation.js
const Joi = require('joi');
const { BUSINESS_TYPES, DEFAULT_CURRENCY, ACCOUNT_TYPES, ACCOUNT_SUBTYPES, NORMAL_BALANCE } = require('../config/constants');

const objectIdPattern = /^[0-9a-fA-F]{24}$/;

/**
 * Logo may be either an http(s) URL or an uploaded image stored inline as a
 * base64 data URI (data:image/png;base64,...). We cap the length so a single
 * oversized upload can't bloat the business document. ~3MB of base64 ≈ a ~2MB
 * image, which is plenty for a logo.
 */
const logoSchema = Joi.string()
  .allow('', null)
  .max(3_000_000)
  .custom((value, helpers) => {
    if (!value) return value;
    const isUrl = /^https?:\/\//i.test(value);
    const isDataImage = /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(value);
    if (!isUrl && !isDataImage) return helpers.error('any.invalid');
    return value;
  })
  .messages({
    'any.invalid': 'Logo must be an http(s) URL or an uploaded image file',
    'string.max': 'Logo image is too large (max ~2MB). Please use a smaller image.',
  });

const contactFields = {
  phone: Joi.string().max(40).allow('', null).trim().optional(),
  email: Joi.string().email({ tlds: false }).max(120).allow('', null).trim().optional()
    .messages({ 'string.email': 'Please enter a valid email address' }),
  address: Joi.string().max(300).allow('', null).trim().optional(),
  website: Joi.string().uri().max(200).allow('', null).trim().optional()
    .messages({ 'string.uri': 'Website must be a valid URL (e.g., https://example.com)' }),
  reportingCurrency: Joi.string().length(3).uppercase().allow('', null).optional(),
};

/**
 * Schema for destructive actions (reset data / delete business). The caller must
 * echo back the exact business name as a typed confirmation.
 */
const confirmActionSchema = Joi.object({
  confirmName: Joi.string().required().trim().messages({
    'any.required': 'Please type your business name to confirm',
    'string.empty': 'Please type your business name to confirm',
  }),
});

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
  logoUrl: logoSchema.optional(),
  ...contactFields,
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
  logoUrl: logoSchema.optional(),
  ...contactFields,
  aiSettings: Joi.object({
    autoPostEnabled: Joi.boolean(),
  }).optional(),
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
  accountSubtype: Joi.string().valid(...Object.values(ACCOUNT_SUBTYPES)).allow(null, '').optional(),
  accountCode: Joi.string().max(20).trim().allow(null, '').optional(),
  parentAccountId: Joi.string().pattern(objectIdPattern).allow(null).optional(),
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
  accountSubtype: Joi.string().valid(...Object.values(ACCOUNT_SUBTYPES)).allow(null, '').optional(),
  accountCode: Joi.string().max(20).trim().allow(null, '').optional(),
  parentAccountId: Joi.string().pattern(objectIdPattern).allow(null).optional(),
  normalBalance: Joi.string().valid(...Object.values(NORMAL_BALANCE)).optional(),
}).min(1);

/**
 * Schema for listing accounts (query parameters).
 * Used in GET /business/accounts
 *
 * NOTE: page/limit are intentionally removed. The endpoint now returns the
 * complete Chart of Accounts without pagination. See controller comment.
 */
const listAccountsQuerySchema = Joi.object({
  accountType: Joi.string().valid(...Object.values(ACCOUNT_TYPES)).optional(),
});

module.exports = {
  createBusinessSchema,
  updateBusinessSchema,
  confirmActionSchema,
  addCustomAccountSchema,
  updateAccountSchema,
  listAccountsQuerySchema,
};
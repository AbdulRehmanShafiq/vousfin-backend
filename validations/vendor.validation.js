// validations/vendor.validation.js
const Joi = require('joi');

// Phase 5.4.4 — WHT profile sub-schema
const whtProfileSchema = Joi.object({
  enabled:    Joi.boolean().default(false),
  category:   Joi.string().max(50).allow(null, '').optional(),
  isNonFiler: Joi.boolean().optional(),
  customRate: Joi.number().min(0).max(100).allow(null).optional(),
  strn:       Joi.string().max(30).allow(null, '').trim().optional(),
});

const createVendorSchema = Joi.object({
  vendorName: Joi.string().min(2).max(150).required().trim().messages({
    'string.min': 'Vendor name must be at least 2 characters',
    'string.max': 'Vendor name cannot exceed 150 characters',
    'any.required': 'Vendor name is required',
  }),
  contactPerson: Joi.string().max(100).allow('', null).trim().optional(),
  phone: Joi.string().max(20).allow('', null).trim().optional(),
  email: Joi.string().email().max(100).allow('', null).trim().optional(),
  address: Joi.string().max(300).allow('', null).trim().optional(),
  taxId: Joi.string().max(50).allow('', null).trim().optional(),
  paymentTerms: Joi.string().max(100).allow('', null).trim().optional(),
  notes: Joi.string().max(500).allow('', null).trim().optional(),
  isActive: Joi.boolean().default(true).optional(),
  // Phase 5.4.4 — WHT profile (optional)
  whtProfile: whtProfileSchema.optional(),
});

const updateVendorSchema = Joi.object({
  vendorName: Joi.string().min(2).max(150).trim().optional(),
  contactPerson: Joi.string().max(100).allow('', null).trim().optional(),
  phone: Joi.string().max(20).allow('', null).trim().optional(),
  email: Joi.string().email().max(100).allow('', null).trim().optional(),
  address: Joi.string().max(300).allow('', null).trim().optional(),
  taxId: Joi.string().max(50).allow('', null).trim().optional(),
  paymentTerms: Joi.string().max(100).allow('', null).trim().optional(),
  notes: Joi.string().max(500).allow('', null).trim().optional(),
  isActive: Joi.boolean().optional(),
  // Phase 5.4.4 — WHT profile
  whtProfile: whtProfileSchema.optional(),
}).min(1);

const vendorIdParamSchema = Joi.object({
  id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required().messages({
    'string.pattern.base': 'Invalid vendor ID format',
    'any.required': 'Vendor ID is required',
  }),
});

const vendorFiltersSchema = Joi.object({
  search: Joi.string().max(100).allow('', null).optional(),
  isActive: Joi.boolean().optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
  sortBy: Joi.string().valid('vendorName', 'currentPayableBalance', 'createdAt').default('vendorName'),
  sortOrder: Joi.number().valid(1, -1).default(1),
});

module.exports = {
  createVendorSchema,
  updateVendorSchema,
  vendorIdParamSchema,
  vendorFiltersSchema,
};

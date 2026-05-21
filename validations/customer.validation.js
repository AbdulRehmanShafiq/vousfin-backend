// validations/customer.validation.js
const Joi = require('joi');

const createCustomerSchema = Joi.object({
  fullName: Joi.string().min(2).max(100).required().trim().messages({
    'string.min': 'Full name must be at least 2 characters',
    'string.max': 'Full name cannot exceed 100 characters',
    'any.required': 'Full name is required',
  }),
  businessName: Joi.string().max(150).allow('', null).trim().optional(),
  phone: Joi.string().max(20).allow('', null).trim().optional(),
  email: Joi.string().email().max(100).allow('', null).trim().optional(),
  address: Joi.string().max(300).allow('', null).trim().optional(),
  taxId: Joi.string().max(50).allow('', null).trim().optional(),
  paymentTerms: Joi.string().max(100).allow('', null).trim().optional(),
  notes: Joi.string().max(500).allow('', null).trim().optional(),
  isActive: Joi.boolean().default(true).optional(),
});

const updateCustomerSchema = Joi.object({
  fullName: Joi.string().min(2).max(100).trim().optional(),
  businessName: Joi.string().max(150).allow('', null).trim().optional(),
  phone: Joi.string().max(20).allow('', null).trim().optional(),
  email: Joi.string().email().max(100).allow('', null).trim().optional(),
  address: Joi.string().max(300).allow('', null).trim().optional(),
  taxId: Joi.string().max(50).allow('', null).trim().optional(),
  paymentTerms: Joi.string().max(100).allow('', null).trim().optional(),
  notes: Joi.string().max(500).allow('', null).trim().optional(),
  isActive: Joi.boolean().optional(),
}).min(1);

const customerIdParamSchema = Joi.object({
  id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required().messages({
    'string.pattern.base': 'Invalid customer ID format',
    'any.required': 'Customer ID is required',
  }),
});

const customerFiltersSchema = Joi.object({
  search: Joi.string().max(100).allow('', null).optional(),
  isActive: Joi.boolean().optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
  sortBy: Joi.string().valid('fullName', 'currentReceivableBalance', 'createdAt').default('fullName'),
  sortOrder: Joi.number().valid(1, -1).default(1),
});

module.exports = {
  createCustomerSchema,
  updateCustomerSchema,
  customerIdParamSchema,
  customerFiltersSchema,
};

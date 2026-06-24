// validations/admin.validation.js
const Joi = require('joi');
const { USER_STATUS, USER_ROLES } = require('../config/constants');

/**
 * Query parameters for listing all customers.
 * Used in GET /admin/customers
 */
const listCustomersQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1).optional(),
  limit: Joi.number().integer().min(1).max(100).default(25).optional(),
  search: Joi.string().max(100).optional().allow('', null),
  status: Joi.string().valid(...Object.values(USER_STATUS)).optional(),
});

/**
 * Query parameters for listing all businesses.
 * Used in GET /admin/businesses
 */
const listBusinessesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1).optional(),
  limit: Joi.number().integer().min(1).max(100).default(25).optional(),
  search: Joi.string().max(100).optional().allow('', null),
});

/**
 * URL parameter for customer/user ID (MongoDB ObjectId).
 */
const customerIdParamSchema = Joi.object({
  id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required().messages({
    'string.pattern.base': 'Invalid customer ID format',
    'any.required': 'Customer ID is required',
  }),
});

/**
 * Request body for suspending a customer.
 */
const suspendCustomerBodySchema = Joi.object({
  reason: Joi.string().max(500).optional().allow('', null),
});

/**
 * Request body for reinstating a customer.
 */
const reinstateCustomerBodySchema = Joi.object({}).optional();

/**
 * Request body for deleting a customer.
 */
const deleteCustomerBodySchema = Joi.object({
  confirm: Joi.boolean().default(true).optional(),
});

/**
 * Request body for changing a user's role.
 * Used in PUT /admin/customers/:id/role
 */
const changeRoleBodySchema = Joi.object({
  role: Joi.string().valid(USER_ROLES.ADMIN, USER_ROLES.CUSTOMER).required().messages({
    'any.only': 'Role must be either "admin" or "customer"',
    'any.required': 'Role is required',
  }),
});

/**
 * Query parameters for system stats (no fields needed).
 */
const systemStatsQuerySchema = Joi.object({}).optional();

module.exports = {
  listCustomersQuerySchema,
  listBusinessesQuerySchema,
  customerIdParamSchema,
  suspendCustomerBodySchema,
  reinstateCustomerBodySchema,
  deleteCustomerBodySchema,
  changeRoleBodySchema,
  systemStatsQuerySchema,
};

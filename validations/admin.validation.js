// validations/admin.validation.js
const Joi = require('joi');
const { USER_STATUS, USER_ROLES } = require('../config/constants');

/**
 * Query parameters for listing all customers.
 * Used in GET /admin/customers
 * - page: positive integer (default 1)
 * - limit: positive integer between 1 and 100 (default 25)
 * - search: optional string (max 100 chars)
 * - status: optional, must be one of USER_STATUS values (pending, active, suspended, deleted)
 */
const listCustomersQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1).optional(),
  limit: Joi.number().integer().min(1).max(100).default(25).optional(),
  search: Joi.string().max(100).optional().allow('', null),
  status: Joi.string().valid(...Object.values(USER_STATUS)).optional(),
});

/**
 * URL parameter for customer ID (MongoDB ObjectId).
 * Used in GET /admin/customers/:id, PUT /admin/customers/:id/suspend, etc.
 */
const customerIdParamSchema = Joi.object({
  id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required().messages({
    'string.pattern.base': 'Invalid customer ID format',
    'any.required': 'Customer ID is required',
  }),
});

/**
 * Request body for suspending a customer.
 * - reason: optional string (max 500 chars) – reason for suspension
 */
const suspendCustomerBodySchema = Joi.object({
  reason: Joi.string().max(500).optional().allow('', null),
});

/**
 * Request body for reinstating a customer (no fields needed, but we keep for consistency).
 */
const reinstateCustomerBodySchema = Joi.object({}).optional();

/**
 * Request body for deleting a customer (confirmation field optional).
 */
const deleteCustomerBodySchema = Joi.object({
  confirm: Joi.boolean().default(true).optional(),
});

/**
 * Query parameters for system stats (no fields needed).
 */
const systemStatsQuerySchema = Joi.object({}).optional();

module.exports = {
  listCustomersQuerySchema,
  customerIdParamSchema,
  suspendCustomerBodySchema,
  reinstateCustomerBodySchema,
  deleteCustomerBodySchema,
  systemStatsQuerySchema,
};
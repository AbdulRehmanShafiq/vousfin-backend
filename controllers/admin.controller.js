// controllers/admin.controller.js
const adminService = require('../services/admin.service');
const ApiResponse = require('../utils/ApiResponse');

/**
 * Get all customers with pagination and filters.
 * GET /api/v1/admin/customers
 * Query: page, limit, search, status
 */
const getAllCustomers = async (req, res, next) => {
  try {
    const { page, limit, search, status } = req.query;
    const result = await adminService.getAllCustomers({ page, limit, search, status });
    ApiResponse.success(res, result, 'Customers retrieved successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Get a single customer by ID.
 * GET /api/v1/admin/customers/:id
 */
const getCustomerById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const customer = await adminService.getCustomerById(id);
    ApiResponse.success(res, customer, 'Customer details retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Suspend a customer account.
 * PUT /api/v1/admin/customers/:id/suspend
 * Body: { reason } (optional)
 */
const suspendCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const updated = await adminService.suspendCustomer(id, req.user.id, reason, req.ip);
    ApiResponse.success(res, updated, 'Customer account suspended');
  } catch (error) {
    next(error);
  }
};

/**
 * Reinstate a suspended customer account.
 * PUT /api/v1/admin/customers/:id/reinstate
 */
const reinstateCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updated = await adminService.reinstateCustomer(id, req.user.id, req.ip);
    ApiResponse.success(res, updated, 'Customer account reinstated');
  } catch (error) {
    next(error);
  }
};

/**
 * Delete a customer account (soft delete).
 * DELETE /api/v1/admin/customers/:id
 */
const deleteCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    await adminService.deleteCustomer(id, req.user.id, req.ip);
    ApiResponse.success(res, null, 'Customer account deleted successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Get system statistics for admin dashboard.
 * GET /api/v1/admin/stats
 */
const getSystemStats = async (req, res, next) => {
  try {
    const stats = await adminService.getSystemStats();
    ApiResponse.success(res, stats, 'System statistics retrieved');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAllCustomers,
  getCustomerById,
  suspendCustomer,
  reinstateCustomer,
  deleteCustomer,
  getSystemStats,
};
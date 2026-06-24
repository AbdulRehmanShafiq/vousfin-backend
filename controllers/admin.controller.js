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

/**
 * Get all businesses with owner info (paginated).
 * GET /api/v1/admin/businesses
 * Query: page, limit, search
 */
const getAllBusinesses = async (req, res, next) => {
  try {
    const { page, limit, search } = req.query;
    const result = await adminService.getAllBusinesses({ page, limit, search });
    ApiResponse.success(res, result, 'Businesses retrieved successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Manually verify (activate) a pending customer.
 * PUT /api/v1/admin/customers/:id/verify
 */
const verifyCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updated = await adminService.verifyCustomer(id, req.user.id, req.ip);
    ApiResponse.success(res, updated, 'Customer account verified and activated');
  } catch (error) {
    next(error);
  }
};

/**
 * Change a user's role (promote/demote).
 * PUT /api/v1/admin/customers/:id/role
 * Body: { role }
 */
const changeRole = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    const updated = await adminService.changeRole(id, req.user.id, role);
    ApiResponse.success(res, updated, `User role updated to ${role}`);
  } catch (error) {
    next(error);
  }
};

// ─── Feedback ─────────────────────────────────────────────────────────────────

const listFeedback = async (req, res, next) => {
  try {
    const { status, type, page, limit } = req.query;
    const result = await adminService.listFeedback({ status, type, page, limit });
    ApiResponse.success(res, result, 'Feedback retrieved');
  } catch (err) { next(err); }
};

const updateFeedbackStatus = async (req, res, next) => {
  try {
    const doc = await adminService.updateFeedbackStatus(req.params.id, req.body);
    ApiResponse.success(res, doc, 'Feedback updated');
  } catch (err) { next(err); }
};

// ─── Support tickets ──────────────────────────────────────────────────────────

const listSupportTickets = async (req, res, next) => {
  try {
    const { status, priority, page, limit } = req.query;
    const result = await adminService.listSupportTickets({ status, priority, page, limit });
    ApiResponse.success(res, result, 'Support tickets retrieved');
  } catch (err) { next(err); }
};

const getSupportTicket = async (req, res, next) => {
  try {
    const ticket = await adminService.getSupportTicket(req.params.id);
    ApiResponse.success(res, ticket, 'Ticket retrieved');
  } catch (err) { next(err); }
};

const addAdminTicketReply = async (req, res, next) => {
  try {
    const ticket = await adminService.addAdminTicketReply(req.params.id, req.user.id, req.body.body);
    ApiResponse.success(res, ticket, 'Reply added');
  } catch (err) { next(err); }
};

const updateSupportTicket = async (req, res, next) => {
  try {
    const ticket = await adminService.updateSupportTicket(req.params.id, req.body);
    ApiResponse.success(res, ticket, 'Ticket updated');
  } catch (err) { next(err); }
};

// ─── Announcements ────────────────────────────────────────────────────────────

const listAnnouncements = async (req, res, next) => {
  try {
    const data = await adminService.listAnnouncements();
    ApiResponse.success(res, data, 'Announcements retrieved');
  } catch (err) { next(err); }
};

const createAnnouncement = async (req, res, next) => {
  try {
    const doc = await adminService.createAnnouncement(req.body, req.user);
    ApiResponse.created(res, doc, 'Announcement created');
  } catch (err) { next(err); }
};

const updateAnnouncement = async (req, res, next) => {
  try {
    const doc = await adminService.updateAnnouncement(req.params.id, req.body);
    ApiResponse.success(res, doc, 'Announcement updated');
  } catch (err) { next(err); }
};

const removeAnnouncement = async (req, res, next) => {
  try {
    await adminService.removeAnnouncement(req.params.id);
    ApiResponse.success(res, null, 'Announcement deleted');
  } catch (err) { next(err); }
};

// ─── Platform activity ────────────────────────────────────────────────────────

const getRecentActivity = async (req, res, next) => {
  try {
    const { page, limit } = req.query;
    const result = await adminService.getRecentActivity({ page, limit });
    ApiResponse.success(res, result, 'Platform activity retrieved');
  } catch (err) { next(err); }
};

// ─── Reset MFA ────────────────────────────────────────────────────────────────

const resetUserMfa = async (req, res, next) => {
  try {
    const result = await adminService.resetUserMfa(req.params.id, req.user.id);
    ApiResponse.success(res, result, result.message);
  } catch (err) { next(err); }
};

module.exports = {
  getAllCustomers,
  getCustomerById,
  suspendCustomer,
  reinstateCustomer,
  deleteCustomer,
  getSystemStats,
  getAllBusinesses,
  verifyCustomer,
  changeRole,
  // new
  listFeedback,
  updateFeedbackStatus,
  listSupportTickets,
  getSupportTicket,
  addAdminTicketReply,
  updateSupportTicket,
  listAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  removeAnnouncement,
  getRecentActivity,
  resetUserMfa,
};

// services/admin.service.js
const userRepository = require('../repositories/user.repository');
const businessRepository = require('../repositories/business.repository');
const accountRepository = require('../repositories/account.repository');
const transactionRepository = require('../repositories/transaction.repository');
const auditService = require('./audit.service');
const { sendAccountStatusEmail } = require('../utils/email.utils');
const { ApiError } = require('../utils/ApiError');
const { USER_STATUS, USER_ROLES } = require('../config/constants');
const logger = require('../config/logger');

const AuditLog = require('../models/AuditLog.model');
const userFeedbackService = require('./userFeedback.service');
const supportService = require('./support.service');
const announcementService = require('./announcement.service');

class AdminService {
  /**
   * Get all customer accounts with pagination and filters.
   * @param {Object} options - { page, limit, search, status }
   * @returns {Promise<{data: Array, total: number, page: number, limit: number}>}
   */
  async getAllCustomers(options = {}) {
    const { page = 1, limit = 25, search = '', status = null } = options;
    return userRepository.findAllCustomersWithBusiness({ page, limit, search, status });
  }

  /**
   * Get detailed customer profile (excluding financial data).
   * @param {string} customerId
   * @returns {Promise<Object>} Customer profile with business info and basic stats
   */
  async getCustomerById(customerId) {
    const user = await userRepository.findById(customerId);
    if (!user || user.role !== USER_ROLES.CUSTOMER) {
      throw new ApiError(404, 'Customer not found');
    }

    // Fetch associated business
    let business = null;
    let transactionCount = 0;
    let accountCount = 0;
    if (user.businessId) {
      business = await businessRepository.findById(user.businessId);
      transactionCount = await transactionRepository.count({ businessId: user.businessId });
      accountCount = await accountRepository.count({ businessId: user.businessId });
    }

    // Return safe profile – no financial transactions
    return {
      _id: user._id,
      fullName: user.fullName,
      email: user.email,
      status: user.status,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
      business: business ? {
        _id: business._id,
        businessName: business.businessName,
        businessType: business.businessType,
        currency: business.currency,
        createdAt: business.createdAt,
      } : null,
      stats: {
        transactionCount,
        accountCount,
      },
    };
  }

  /**
   * Suspend a customer account.
   * @param {string} customerId
   * @param {string} adminId - ID of admin performing action
   * @param {string} reason - Optional reason for suspension
   * @param {string} ipAddress
   * @returns {Promise<Object>} Updated user
   */
  async suspendCustomer(customerId, adminId, reason = '', ipAddress) {
    // Prevent self-suspension
    if (customerId === adminId) {
      throw new ApiError(403, 'Admin cannot suspend their own account');
    }

    const user = await userRepository.findById(customerId);
    if (!user || user.role !== USER_ROLES.CUSTOMER) {
      throw new ApiError(404, 'Customer not found');
    }
    if (user.status === USER_STATUS.SUSPENDED) {
      throw new ApiError(400, 'Account is already suspended');
    }
    if (user.status === USER_STATUS.DELETED) {
      throw new ApiError(400, 'Account is already deleted');
    }

    const updatedUser = await userRepository.updateStatus(customerId, USER_STATUS.SUSPENDED);

    // Audit log
    await auditService.logStatusChange('user', customerId, user.businessId, adminId, user.status, USER_STATUS.SUSPENDED, ipAddress);

    // Send email notification
    try {
      await sendAccountStatusEmail(user.email, user.fullName, 'suspended', reason);
    } catch (emailErr) {
      logger.error(`Failed to send suspension email to ${user.email}: ${emailErr.message}`);
    }

    logger.info(`Admin ${adminId} suspended customer ${customerId} from IP ${ipAddress}`);
    return updatedUser;
  }

  /**
   * Reinstate a suspended customer account.
   * @param {string} customerId
   * @param {string} adminId
   * @param {string} ipAddress
   * @returns {Promise<Object>} Updated user
   */
  async reinstateCustomer(customerId, adminId, ipAddress) {
    const user = await userRepository.findById(customerId);
    if (!user || user.role !== USER_ROLES.CUSTOMER) {
      throw new ApiError(404, 'Customer not found');
    }
    if (user.status !== USER_STATUS.SUSPENDED) {
      throw new ApiError(400, 'Account is not suspended');
    }

    const updatedUser = await userRepository.updateStatus(customerId, USER_STATUS.ACTIVE);

    await auditService.logStatusChange('user', customerId, user.businessId, adminId, user.status, USER_STATUS.ACTIVE, ipAddress);

    try {
      await sendAccountStatusEmail(user.email, user.fullName, 'reinstated');
    } catch (emailErr) {
      logger.error(`Failed to send reinstatement email to ${user.email}: ${emailErr.message}`);
    }

    logger.info(`Admin ${adminId} reinstated customer ${customerId}`);
    return updatedUser;
  }

  /**
   * Permanently delete a customer account and all associated data.
   * This is a soft delete (status = 'deleted') and also removes the business cascade.
   * @param {string} customerId
   * @param {string} adminId
   * @param {string} ipAddress
   * @returns {Promise<void>}
   */
  async deleteCustomer(customerId, adminId, ipAddress) {
    if (customerId === adminId) {
      throw new ApiError(403, 'Admin cannot delete their own account');
    }

    const user = await userRepository.findById(customerId);
    if (!user || user.role !== USER_ROLES.CUSTOMER) {
      throw new ApiError(404, 'Customer not found');
    }
    if (user.status === USER_STATUS.DELETED) {
      throw new ApiError(400, 'Account is already deleted');
    }

    // If business exists, delete it (cascades: accounts, transactions, audit logs, anomalies)
    if (user.businessId) {
      const BusinessService = require('./business.service');
      await BusinessService.deleteBusiness(user.businessId, adminId);
    }

    // Soft delete user
    await userRepository.updateStatus(customerId, USER_STATUS.DELETED);

    await auditService.logDelete('user', customerId, user.businessId, adminId, { email: user.email, fullName: user.fullName }, ipAddress);

    try {
      await sendAccountStatusEmail(user.email, user.fullName, 'deleted');
    } catch (emailErr) {
      logger.error(`Failed to send deletion email to ${user.email}: ${emailErr.message}`);
    }

    logger.warn(`Admin ${adminId} deleted customer ${customerId} (${user.email})`);
  }

  /**
   * Get system statistics for admin dashboard.
   * @returns {Promise<Object>}
   */
  async getSystemStats() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [
      totalUsers,
      activeCustomers,
      suspendedCustomers,
      totalBusinesses,
      pendingCustomers,
      adminCount,
      totalTransactions,
      newUsersLast30Days,
    ] = await Promise.all([
      userRepository.count(),
      userRepository.count({ role: USER_ROLES.CUSTOMER, status: USER_STATUS.ACTIVE }),
      userRepository.count({ role: USER_ROLES.CUSTOMER, status: USER_STATUS.SUSPENDED }),
      businessRepository.getTotalBusinessCount(),
      userRepository.count({ role: USER_ROLES.CUSTOMER, status: USER_STATUS.PENDING }),
      userRepository.count({ role: USER_ROLES.ADMIN }),
      transactionRepository.count({}),
      userRepository.count({ createdAt: { $gte: thirtyDaysAgo } }),
    ]);

    return {
      totalUsers,
      activeCustomers,
      suspendedCustomers,
      totalBusinesses,
      pendingCustomers,
      adminCount,
      totalTransactions,
      newUsersLast30Days,
    };
  }

  /**
   * Get all businesses with owner info, paginated.
   * @param {Object} options - { page, limit, search }
   * @returns {Promise<{data: Array, total: number, page: number, limit: number}>}
   */
  async getAllBusinesses(options = {}) {
    const { page = 1, limit = 25, search = '' } = options;
    const result = await businessRepository.findAllWithOwner({ page, limit, search });
    // Normalize: rename userId -> owner for cleaner API surface
    return {
      ...result,
      data: result.data.map((b) => {
        const { userId, ...rest } = b;
        return { ...rest, owner: userId || null };
      }),
    };
  }

  /**
   * Manually activate a pending customer (admin override of email verification).
   * @param {string} customerId
   * @param {string} adminId
   * @param {string} ipAddress
   * @returns {Promise<Object>} Updated user
   */
  async verifyCustomer(customerId, adminId, ipAddress) {
    const user = await userRepository.findById(customerId);
    if (!user || user.role !== USER_ROLES.CUSTOMER) {
      throw new ApiError(404, 'Customer not found');
    }
    if (user.status === USER_STATUS.ACTIVE) {
      throw new ApiError(400, 'Account is already active');
    }
    if (user.status === USER_STATUS.DELETED) {
      throw new ApiError(400, 'Account is already deleted');
    }

    const beforeStatus = user.status;
    const updatedUser = await userRepository.update(customerId, {
      status: USER_STATUS.ACTIVE,
      verificationToken: null,
    });

    await auditService.logStatusChange(
      'user', customerId, user.businessId, adminId,
      beforeStatus, USER_STATUS.ACTIVE, ipAddress,
    );

    logger.info(`Admin ${adminId} manually verified customer ${customerId}`);
    return updatedUser;
  }

  // ─── Feedback (admin) ────────────────────────────────────────────────────────

  async listFeedback(opts) { return userFeedbackService.listAll(opts); }
  async updateFeedbackStatus(id, data) { return userFeedbackService.updateStatus(id, data); }

  // ─── Support tickets (admin) ──────────────────────────────────────────────────

  async listSupportTickets(opts) { return supportService.listAll(opts); }
  async getSupportTicket(id) { return supportService.getTicketAdmin(id); }
  async addAdminTicketReply(id, adminId, body) { return supportService.addAdminReply(id, adminId, body); }
  async updateSupportTicket(id, data) { return supportService.updateTicket(id, data); }

  // ─── Announcements (admin) ────────────────────────────────────────────────────

  async listAnnouncements() { return announcementService.listAll(); }
  async createAnnouncement(data, actor) { return announcementService.create(data, actor); }
  async updateAnnouncement(id, data) { return announcementService.update(id, data); }
  async removeAnnouncement(id) { return announcementService.remove(id); }

  // ─── Platform activity log ───────────────────────────────────────────────────

  /**
   * Cross-business platform activity — newest first, paginated.
   */
  async getRecentActivity({ page = 1, limit = 50 } = {}) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      AuditLog.find({}).sort({ timestamp: -1 }).skip(skip).limit(Number(limit)).lean(),
      AuditLog.countDocuments({}),
    ]);
    return { data, total, page: Number(page), limit: Number(limit) };
  }

  // ─── Reset user MFA (admin) ───────────────────────────────────────────────────

  /**
   * Clear MFA for a user. Audit-logs the action.
   */
  async resetUserMfa(userId, adminId) {
    const user = await userRepository.findById(userId);
    if (!user) throw new ApiError(404, 'User not found');

    await userRepository.update(userId, {
      'mfa.enabled':     false,
      'mfa.secret':      null,
      'mfa.backupCodes': [],
    });

    await auditService.log({
      entityType:      'user',
      entityId:        userId,
      businessId:      user.businessId || null,
      action:          'UPDATED',
      performedBy:     adminId,
      beforeState:     { mfaEnabled: user.mfa?.enabled },
      afterState:      { mfaEnabled: false },
    });

    logger.info(`Admin ${adminId} reset MFA for user ${userId}`);
    return { message: 'MFA has been reset for this user.' };
  }

  /**
   * Change the role of a user (promote to admin / demote to customer).
   * @param {string} userId
   * @param {string} adminId - performing admin
   * @param {string} newRole - 'admin' | 'customer'
   * @returns {Promise<Object>} Updated user
   */
  async changeRole(userId, adminId, newRole) {
    if (userId === adminId) {
      throw new ApiError(403, 'You cannot change your own role.');
    }
    if (![USER_ROLES.ADMIN, USER_ROLES.CUSTOMER].includes(newRole)) {
      throw new ApiError(400, `Invalid role: ${newRole}`);
    }

    const user = await userRepository.findById(userId);
    if (!user) {
      throw new ApiError(404, 'User not found');
    }

    // Guard: cannot demote the last admin
    if (user.role === USER_ROLES.ADMIN && newRole === USER_ROLES.CUSTOMER) {
      const adminCount = await userRepository.count({ role: USER_ROLES.ADMIN });
      if (adminCount <= 1) {
        throw new ApiError(400, 'Cannot demote the last admin.');
      }
    }

    const updatedUser = await userRepository.update(userId, { role: newRole });

    await auditService.log({
      entityType: 'user',
      entityId: userId,
      businessId: user.businessId,
      action: 'ROLE_CHANGED',
      performedBy: adminId,
      beforeState: { role: user.role },
      afterState: { role: newRole },
    });

    logger.info(`Admin ${adminId} changed role of user ${userId}: ${user.role} → ${newRole}`);
    return updatedUser;
  }
}

module.exports = new AdminService();

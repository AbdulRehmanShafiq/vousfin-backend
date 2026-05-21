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

    const beforeState = { status: user.status };
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

    const beforeState = { status: user.status };
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
    const [totalUsers, activeCustomers, suspendedCustomers, totalBusinesses] = await Promise.all([
      userRepository.count(),
      userRepository.count({ role: USER_ROLES.CUSTOMER, status: USER_STATUS.ACTIVE }),
      userRepository.count({ role: USER_ROLES.CUSTOMER, status: USER_STATUS.SUSPENDED }),
      businessRepository.getTotalBusinessCount(),
    ]);
    return {
      totalUsers,
      activeCustomers,
      suspendedCustomers,
      totalBusinesses,
      // Additional stats can be added here
    };
  }
}

module.exports = new AdminService();
// services/business.service.js
const businessRepository = require('../repositories/business.repository');
const accountRepository = require('../repositories/account.repository');
const userRepository = require('../repositories/user.repository');
const { ApiError } = require('../utils/ApiError');
const { USER_STATUS, BUSINESS_TYPES, DEFAULT_CURRENCY } = require('../config/constants');
const logger = require('../config/logger');

class BusinessService {
  /**
   * Create a new business profile for a user and seed default chart of accounts.
   * @param {string} userId - User ID (must be active and not have a business)
   * @param {Object} businessData - { businessName, businessType, currency, fiscalYearStartMonth, logoUrl (optional) }
   * @param {string} ipAddress
   * @returns {Promise<Object>} - Created business object
   */
  async createBusiness(userId, businessData, ipAddress) {
    // Validate user exists and is active
    const user = await userRepository.findActiveById(userId);
    if (!user) {
      throw new ApiError(404, 'User not found or inactive');
    }
    if (user.status !== USER_STATUS.ACTIVE) {
      throw new ApiError(403, 'Account not verified. Please verify your email first.');
    }

    // Check if user already has a business
    const existing = await businessRepository.existsForUser(userId);
    if (existing) {
      throw new ApiError(409, 'Business profile already exists for this user');
    }

    // Validate business type
    if (!BUSINESS_TYPES.includes(businessData.businessType)) {
      throw new ApiError(400, `Invalid business type. Must be one of: ${BUSINESS_TYPES.join(', ')}`);
    }

    // Validate fiscal year month
    let fiscalYearStartMonth = businessData.fiscalYearStartMonth || 1;
    if (fiscalYearStartMonth < 1 || fiscalYearStartMonth > 12) {
      throw new ApiError(400, 'Fiscal year start month must be between 1 and 12');
    }

    // Create business
    const business = await businessRepository.create({
      userId,
      businessName: businessData.businessName.trim(),
      registrationNumber: businessData.registrationNumber?.trim() || null,
      businessType: businessData.businessType,
      currency: businessData.currency || DEFAULT_CURRENCY,
      fiscalYearStartMonth,
      logoUrl: businessData.logoUrl || null,
    });

    // Seed default Chart of Accounts
    await accountRepository.bulkCreateDefaultAccounts(business._id);

    // Link business to user
    await userRepository.update(userId, { businessId: business._id });

    logger.info(`Business created for user ${userId} (${business.businessName}) from IP ${ipAddress}`);
    return business;
  }

  /**
   * Get business profile by user ID.
   * @param {string} userId
   * @param {boolean} includeAccountCount - Whether to include total number of accounts
   * @returns {Promise<Object|null>}
   */
  async getBusinessByUserId(userId, includeAccountCount = false) {
    const business = await businessRepository.findByUserId(userId);
    if (!business) return null;

    if (includeAccountCount) {
      const accounts = await accountRepository.findByBusiness(business._id);
      business._doc = business._doc || {};
      business._doc.accountCount = accounts.length;
    }
    return business;
  }

  /**
   * Update business settings.
   * @param {string} businessId
   * @param {Object} updateData - Fields to update (businessName, businessType, currency, fiscalYearStartMonth, logoUrl)
   * @param {string} userId - For audit logging (who performed the update)
   * @param {string} ipAddress
   * @returns {Promise<Object>} Updated business
   */
  async updateBusiness(businessId, updateData, userId, ipAddress) {
    // Verify business exists
    const business = await businessRepository.findById(businessId);
    if (!business) {
      throw new ApiError(404, 'Business not found');
    }

    // Validate business type if provided
    if (updateData.businessType && !BUSINESS_TYPES.includes(updateData.businessType)) {
      throw new ApiError(400, `Invalid business type. Must be one of: ${BUSINESS_TYPES.join(', ')}`);
    }

    // Validate fiscal year month if provided
    if (updateData.fiscalYearStartMonth !== undefined) {
      const month = parseInt(updateData.fiscalYearStartMonth, 10);
      if (isNaN(month) || month < 1 || month > 12) {
        throw new ApiError(400, 'Fiscal year start month must be between 1 and 12');
      }
      updateData.fiscalYearStartMonth = month;
    }

    const updated = await businessRepository.updateBusinessSettings(businessId, updateData);
    logger.info(`Business ${businessId} updated by user ${userId} from IP ${ipAddress}`);
    return updated;
  }

  /**
   * Check if a user already has a business profile.
   * @param {string} userId
   * @returns {Promise<boolean>}
   */
  async hasBusiness(userId) {
    return businessRepository.existsForUser(userId);
  }

  /**
   * Permanently delete a business and all its associated data.
   * This is a destructive operation – should be used only when a user account is deleted.
   * @param {string} businessId
   * @param {string} userId - User initiating the deletion (for audit)
   * @returns {Promise<void>}
   */
  async deleteBusiness(businessId, userId) {
    // Verify business exists
    const business = await businessRepository.findById(businessId);
    if (!business) {
      throw new ApiError(404, 'Business not found');
    }

    // Delete all associated data in order (dependent collections first)
    // 1. Delete anomaly alerts
    const AnomalyAlert = require('../models/AnomalyAlert.model');
    await AnomalyAlert.deleteMany({ businessId });
    // 2. Delete audit logs
    const AuditLog = require('../models/AuditLog.model');
    await AuditLog.deleteMany({ businessId });
    // 3. Delete journal entries
    const JournalEntry = require('../models/JournalEntry.model');
    await JournalEntry.deleteMany({ businessId });
    // 4. Delete chart of accounts
    await accountRepository.deleteByBusiness(businessId);
    // 5. Delete the business itself
    await businessRepository.delete(businessId);

    // Remove business reference from user
    await userRepository.update(business.userId, { businessId: null });

    logger.warn(`Business ${businessId} (${business.businessName}) deleted by user ${userId}`);
  }
}

module.exports = new BusinessService();
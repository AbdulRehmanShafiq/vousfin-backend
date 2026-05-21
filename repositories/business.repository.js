// repositories/business.repository.js
const BaseRepository = require('./base.repository');
const Business = require('../models/Business.model');
const { BUSINESS_TYPES } = require('../config/constants');
const { sanitizeAndValidateId } = require('../utils/sanitize.helper');
const logger = require('../config/logger');

class BusinessRepository extends BaseRepository {
  constructor() {
    super(Business);
  }

  /**
   * Find business by user ID (one user can have only one business).
   * @param {string} userId
   * @returns {Promise<Object|null>}
   */
  async findByUserId(userId) {
    const validId = sanitizeAndValidateId(userId);
    return this.findOne({ userId: validId });
  }

  /**
   * Find business by user ID and populate the user data.
   * @param {string} userId
   * @returns {Promise<Object|null>}
   */
  async findByUserIdWithPopulatedUser(userId) {
    const validId = sanitizeAndValidateId(userId);
    return this.findOne({ userId: validId }, 'user');
  }

  /**
   * Check if a user already has a business profile.
   * @param {string} userId
   * @returns {Promise<boolean>}
   */
  async existsForUser(userId) {
    const validId = sanitizeAndValidateId(userId);
    return this.exists({ userId: validId });
  }

  /**
   * Update business settings (profile information).
   * @param {string} businessId
   * @param {Object} updateData - Fields to update (businessName, businessType, currency, fiscalYearStartMonth, logoUrl)
   * @returns {Promise<Object|null>}
   */
  async updateBusinessSettings(businessId, updateData) {
    const validId = sanitizeAndValidateId(businessId);
    // Validate business type if provided
    if (updateData.businessType && !BUSINESS_TYPES.includes(updateData.businessType)) {
      throw new Error(`Invalid business type: ${updateData.businessType}`);
    }
    // Validate fiscal year month if provided
    if (updateData.fiscalYearStartMonth !== undefined) {
      const month = parseInt(updateData.fiscalYearStartMonth, 10);
      if (isNaN(month) || month < 1 || month > 12) {
        throw new Error('Fiscal year start month must be between 1 and 12');
      }
      updateData.fiscalYearStartMonth = month;
    }
    // Trim business name if provided
    if (updateData.businessName) {
      updateData.businessName = updateData.businessName.trim();
    }
    return this.update(validId, updateData);
  }

  /**
   * Get all businesses with their owner information (for admin panel).
   * @param {Object} options - { page, limit, search }
   * @returns {Promise<{data: Array, total: number, page: number, limit: number}>}
   */
  async findAllWithOwner(options = {}) {
    const { page = 1, limit = 25, search = '' } = options;
    const skip = (page - 1) * limit;

    const query = {};
    if (search) {
      query.$or = [
        { businessName: { $regex: search, $options: 'i' } },
      ];
    }

    try {
      const data = await this.model.find(query)
        .populate('userId', 'fullName email status lastLogin')
        .skip(skip)
        .limit(limit)
        .sort({ createdAt: -1 })
        .lean();
      const total = await this.count(query);
      return { data, total, page, limit };
    } catch (error) {
      logger.error('Error fetching businesses with owners:', error);
      throw new Error(`Error fetching businesses: ${error.message}`);
    }
  }

  /**
   * Count businesses by type (for admin analytics).
   * @returns {Promise<Array<{_id: string, count: number}>>}
   */
  async countByBusinessType() {
    try {
      const result = await this.model.aggregate([
        { $group: { _id: '$businessType', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]);
      return result;
    } catch (error) {
      logger.error('Error aggregating business types:', error);
      return [];
    }
  }

  /**
   * Get total number of businesses (excluding any soft‑deleted ones – no soft delete on business directly).
   * @returns {Promise<number>}
   */
  async getTotalBusinessCount() {
    return this.count();
  }
}

module.exports = new BusinessRepository();
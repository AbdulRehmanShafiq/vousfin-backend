// repositories/user.repository.js
const BaseRepository = require('./base.repository');
const User = require('../models/User.model');
const { USER_STATUS, USER_ROLES } = require('../config/constants');
const { sanitizeAndValidateId } = require('../utils/sanitize.helper');
const logger = require('../config/logger');

class UserRepository extends BaseRepository {
  constructor() {
    super(User);
  }

  /**
   * Find user by email address (case‑insensitive).
   * @param {string} email
   * @returns {Promise<Object|null>}
   */
  async findByEmail(email) {
    if (!email) return null;
    return this.findOne({ email: email.toLowerCase().trim() });
  }

  /**
   * Find user by Google OAuth ID.
   * @param {string} googleId
   * @returns {Promise<Object|null>}
   */
  async findByGoogleId(googleId) {
    if (!googleId) return null;
    return this.findOne({ googleId });
  }

  /**
   * Find user by ID and ensure it is not deleted.
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async findActiveById(id) {
    const validId = sanitizeAndValidateId(id);
    return this.findOne({ _id: validId, status: { $ne: USER_STATUS.DELETED } });
  }

  /**
   * Find a customer by ID (role = customer).
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async findCustomerById(id) {
    const validId = sanitizeAndValidateId(id);
    return this.findOne({ _id: validId, role: USER_ROLES.CUSTOMER });
  }

  /**
   * Update user status (active, suspended, deleted).
   * @param {string} userId
   * @param {string} status - One of USER_STATUS values
   * @returns {Promise<Object|null>}
   */
  async updateStatus(userId, status) {
    const validId = sanitizeAndValidateId(userId);
    if (!Object.values(USER_STATUS).includes(status)) {
      throw new Error(`Invalid status: ${status}`);
    }
    return this.update(validId, { status });
  }

  /**
   * Add a JWT token to user's blacklist array.
   * @param {string} userId
   * @param {string} token
   * @returns {Promise<boolean>}
   */
  async addToBlacklist(userId, token) {
    const user = await this.findById(userId);
    if (!user) return false;
    if (!user.tokenBlacklist.includes(token)) {
      user.tokenBlacklist.push(token);
      await user.save();
      logger.debug(`Token blacklisted for user ${userId}`);
    }
    return true;
  }

  /**
   * Check if a token is blacklisted for a user.
   * @param {string} userId
   * @param {string} token
   * @returns {Promise<boolean>}
   */
  async isTokenBlacklisted(userId, token) {
    const user = await this.findById(userId);
    if (!user) return false;
    return user.tokenBlacklist.includes(token);
  }

  /**
   * Get all customer accounts with business details (for admin panel).
   * @param {Object} options - { page, limit, search, status }
   * @returns {Promise<{data: Array, total: number, page: number, limit: number}>}
   */
  async findAllCustomersWithBusiness(options = {}) {
    const { page = 1, limit = 25, search = '', status = null } = options;
    const skip = (page - 1) * limit;

    const query = { role: USER_ROLES.CUSTOMER };
    if (status && Object.values(USER_STATUS).includes(status)) {
      query.status = status;
    }
    if (search) {
      query.$or = [
        { fullName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    try {
      const data = await this.model.find(query)
        .populate('businessId', 'businessName businessType currency createdAt')
        .skip(skip)
        .limit(limit)
        .sort({ createdAt: -1 })
        .lean();
      const total = await this.count(query);
      return { data, total, page, limit };
    } catch (error) {
      throw new Error(`Error fetching customers: ${error.message}`);
    }
  }

  /**
   * Count users by status (for admin dashboard stats).
   * @param {string} status
   * @returns {Promise<number>}
   */
  async countByStatus(status) {
    return this.count({ status });
  }

  /**
   * Get total number of customers (excluding admins and deleted).
   * @returns {Promise<number>}
   */
  async countActiveCustomers() {
    return this.count({
      role: USER_ROLES.CUSTOMER,
      status: USER_STATUS.ACTIVE,
    });
  }

  /**
   * Find user with verification token (for email verification).
   * @param {string} token
   * @returns {Promise<Object|null>}
   */
  async findByVerificationToken(token) {
    if (!token) return null;
    return this.findOne({ verificationToken: token });
  }

  /**
   * Clear verification token after successful verification.
   * @param {string} userId
   * @returns {Promise<Object|null>}
   */
  async clearVerificationToken(userId) {
    return this.update(userId, { verificationToken: null });
  }
}

module.exports = new UserRepository();
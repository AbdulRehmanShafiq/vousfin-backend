// repositories/customer.repository.js
const BaseRepository = require('./base.repository');
const Customer = require('../models/Customer.model');
const { sanitizeAndValidateId } = require('../utils/sanitize.helper');
const logger = require('../config/logger');

class CustomerRepository extends BaseRepository {
  constructor() {
    super(Customer);
  }

  /**
   * Find all customers for a business with optional filters and pagination.
   * @param {string} businessId
   * @param {Object} filters - { search, isActive }
   * @param {Object} pagination - { page, limit, sortBy, sortOrder }
   * @returns {Promise<{data: Array, total: number, page: number, limit: number}>}
   */
  async findByBusiness(businessId, filters = {}, pagination = {}) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const {
      page = 1,
      limit = 25,
      sortBy = 'fullName',
      sortOrder = 1,
    } = pagination;
    const skip = (page - 1) * limit;

    const query = { businessId: validBusinessId };

    if (filters.isActive !== undefined) {
      query.isActive = filters.isActive;
    }

    if (filters.search) {
      query.$or = [
        { fullName: { $regex: filters.search, $options: 'i' } },
        { businessName: { $regex: filters.search, $options: 'i' } },
        { email: { $regex: filters.search, $options: 'i' } },
        { phone: { $regex: filters.search, $options: 'i' } },
      ];
    }

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder;

    const [data, total] = await Promise.all([
      this.model.find(query).sort(sortOptions).skip(skip).limit(limit).lean(),
      this.model.countDocuments(query),
    ]);

    return { data, total, page, limit };
  }

  /**
   * Find a customer by business and customer ID.
   * @param {string} businessId
   * @param {string} customerId
   * @returns {Promise<Object|null>}
   */
  async findByBusinessAndId(businessId, customerId) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const validCustomerId = sanitizeAndValidateId(customerId);
    return this.findOne({
      _id: validCustomerId,
      businessId: validBusinessId,
    });
  }

  /**
   * Find a customer by business and email.
   * @param {string} businessId
   * @param {string} email
   * @returns {Promise<Object|null>}
   */
  async findByBusinessAndEmail(businessId, email) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    return this.findOne({
      businessId: validBusinessId,
      email: email.toLowerCase().trim(),
    });
  }

  /**
   * Update receivable balance atomically using $inc.
   * @param {string} customerId
   * @param {number} delta - Positive to increase, negative to decrease
   * @returns {Promise<Object|null>}
   */
  async updateReceivableBalance(customerId, delta) {
    const validCustomerId = sanitizeAndValidateId(customerId);
    if (typeof delta !== 'number' || isNaN(delta)) {
      throw new Error('Delta must be a number');
    }
    return this.model.findByIdAndUpdate(
      validCustomerId,
      { $inc: { currentReceivableBalance: delta } },
      { new: true, runValidators: false }
    ).exec();
  }

  /**
   * Find a customer by name (case-insensitive), or create one if not found.
   * Used during transaction recording to auto-create customers from free-text input.
   * @param {string} businessId
   * @param {string} name
   * @returns {Promise<Object>}
   */
  async findOrCreateByName(businessId, name) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const cleanName = name.trim();
    const escaped = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existing = await this.findOne({
      businessId: validBusinessId,
      fullName: { $regex: new RegExp(`^${escaped}$`, 'i') },
    });
    if (existing) return existing;
    const created = await this.model.create({ businessId: validBusinessId, fullName: cleanName });
    logger.info(`Auto-created customer "${cleanName}" for business ${businessId}`);
    return created;
  }

  /**
   * Get top debtors (customers with highest outstanding receivables).
   * @param {string} businessId
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async getTopDebtors(businessId, limit = 10) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    return this.model.find({
      businessId: validBusinessId,
      isActive: true,
      currentReceivableBalance: { $gt: 0 },
    })
      .sort({ currentReceivableBalance: -1 })
      .limit(limit)
      .lean();
  }
}

module.exports = new CustomerRepository();

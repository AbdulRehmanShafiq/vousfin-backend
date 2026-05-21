// repositories/vendor.repository.js
const BaseRepository = require('./base.repository');
const Vendor = require('../models/Vendor.model');
const { sanitizeAndValidateId } = require('../utils/sanitize.helper');
const logger = require('../config/logger');

class VendorRepository extends BaseRepository {
  constructor() {
    super(Vendor);
  }

  /**
   * Find all vendors for a business with optional filters and pagination.
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
      sortBy = 'vendorName',
      sortOrder = 1,
    } = pagination;
    const skip = (page - 1) * limit;

    const query = { businessId: validBusinessId };

    if (filters.isActive !== undefined) {
      query.isActive = filters.isActive;
    }

    if (filters.search) {
      query.$or = [
        { vendorName: { $regex: filters.search, $options: 'i' } },
        { contactPerson: { $regex: filters.search, $options: 'i' } },
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
   * Find a vendor by business and vendor ID.
   * @param {string} businessId
   * @param {string} vendorId
   * @returns {Promise<Object|null>}
   */
  async findByBusinessAndId(businessId, vendorId) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const validVendorId = sanitizeAndValidateId(vendorId);
    return this.findOne({
      _id: validVendorId,
      businessId: validBusinessId,
    });
  }

  /**
   * Find a vendor by business and email.
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
   * Update payable balance atomically using $inc.
   * @param {string} vendorId
   * @param {number} delta - Positive to increase, negative to decrease
   * @returns {Promise<Object|null>}
   */
  async updatePayableBalance(vendorId, delta) {
    const validVendorId = sanitizeAndValidateId(vendorId);
    if (typeof delta !== 'number' || isNaN(delta)) {
      throw new Error('Delta must be a number');
    }
    return this.model.findByIdAndUpdate(
      validVendorId,
      { $inc: { currentPayableBalance: delta } },
      { new: true, runValidators: false }
    ).exec();
  }

  /**
   * Find a vendor by name (case-insensitive), or create one if not found.
   * Used during transaction recording to auto-create vendors from free-text input.
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
      vendorName: { $regex: new RegExp(`^${escaped}$`, 'i') },
    });
    if (existing) return existing;
    const created = await this.model.create({ businessId: validBusinessId, vendorName: cleanName });
    logger.info(`Auto-created vendor "${cleanName}" for business ${businessId}`);
    return created;
  }

  /**
   * Get top creditors (vendors with highest outstanding payables).
   * @param {string} businessId
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async getTopCreditors(businessId, limit = 10) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    return this.model.find({
      businessId: validBusinessId,
      isActive: true,
      currentPayableBalance: { $gt: 0 },
    })
      .sort({ currentPayableBalance: -1 })
      .limit(limit)
      .lean();
  }
}

module.exports = new VendorRepository();

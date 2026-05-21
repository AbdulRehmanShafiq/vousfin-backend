// repositories/installmentPlan.repository.js
const BaseRepository = require('./base.repository');
const InstallmentPlan = require('../models/InstallmentPlan.model');
const { INSTALLMENT_STATUS, PAYMENT_STATUS } = require('../config/constants');
const { sanitizeAndValidateId } = require('../utils/sanitize.helper');
const logger = require('../config/logger');

class InstallmentPlanRepository extends BaseRepository {
  constructor() {
    super(InstallmentPlan);
  }

  /**
   * Find all installment plans for a business with filters and pagination.
   * @param {string} businessId
   * @param {Object} filters - { status, customerId, vendorId }
   * @param {Object} pagination - { page, limit, sortBy, sortOrder }
   * @returns {Promise<{data: Array, total: number, page: number, limit: number}>}
   */
  async findByBusiness(businessId, filters = {}, pagination = {}) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const {
      page = 1,
      limit = 25,
      sortBy = 'createdAt',
      sortOrder = -1,
    } = pagination;
    const skip = (page - 1) * limit;

    const query = { businessId: validBusinessId };

    if (filters.status && Object.values(INSTALLMENT_STATUS).includes(filters.status)) {
      query.status = filters.status;
    }
    if (filters.customerId) {
      query.customerId = sanitizeAndValidateId(filters.customerId);
    }
    if (filters.vendorId) {
      query.vendorId = sanitizeAndValidateId(filters.vendorId);
    }

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder;

    const [data, total] = await Promise.all([
      this.model.find(query)
        .populate('linkedTransactionId', 'description amount transactionDate')
        .populate('customerId', 'fullName businessName')
        .populate('vendorId', 'vendorName contactPerson')
        .sort(sortOptions)
        .skip(skip)
        .limit(limit)
        .lean(),
      this.model.countDocuments(query),
    ]);

    return { data, total, page, limit };
  }

  /**
   * Find an installment plan by its linked transaction ID.
   * @param {string} linkedTransactionId
   * @returns {Promise<Object|null>}
   */
  async findByTransaction(linkedTransactionId) {
    const validId = sanitizeAndValidateId(linkedTransactionId);
    return this.model.findOne({ linkedTransactionId: validId })
      .populate('linkedTransactionId', 'description amount transactionDate')
      .populate('customerId', 'fullName businessName')
      .populate('vendorId', 'vendorName contactPerson')
      .exec();
  }

  /**
   * Find an installment plan by ID and business.
   * @param {string} planId
   * @param {string} businessId
   * @returns {Promise<Object|null>}
   */
  async findByIdAndBusiness(planId, businessId) {
    const validPlanId = sanitizeAndValidateId(planId);
    const validBusinessId = sanitizeAndValidateId(businessId);
    return this.model.findOne({
      _id: validPlanId,
      businessId: validBusinessId,
    })
      .populate('linkedTransactionId', 'description amount transactionDate')
      .populate('customerId', 'fullName businessName')
      .populate('vendorId', 'vendorName contactPerson')
      .exec();
  }

  /**
   * Get overdue installment plans for a business.
   * @param {string} businessId
   * @returns {Promise<Array>}
   */
  async getOverduePlans(businessId) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    return this.model.find({
      businessId: validBusinessId,
      status: INSTALLMENT_STATUS.ACTIVE,
      nextDueDate: { $lt: new Date() },
    })
      .populate('linkedTransactionId', 'description amount')
      .populate('customerId', 'fullName')
      .populate('vendorId', 'vendorName')
      .lean();
  }

  /**
   * Update plan after recording a payment (save the modified plan document).
   * @param {Object} plan - Mongoose document (not lean)
   * @returns {Promise<Object>}
   */
  async savePlan(plan) {
    return plan.save();
  }
}

module.exports = new InstallmentPlanRepository();

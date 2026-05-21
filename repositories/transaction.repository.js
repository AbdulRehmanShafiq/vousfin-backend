// repositories/transaction.repository.js
const BaseRepository = require('./base.repository');
const JournalEntry = require('../models/JournalEntry.model');
const { TRANSACTION_TYPES, JOURNAL_STATUS, PAYMENT_STATUS } = require('../config/constants');
const { sanitizeAndValidateId, sanitizeQueryObject } = require('../utils/sanitize.helper');
const logger = require('../config/logger');

class TransactionRepository extends BaseRepository {
  constructor() {
    super(JournalEntry);
  }

  /**
   * Create a new journal entry.
   * @param {Object} data - Journal entry data
   * @returns {Promise<Object>}
   */
  async createTransaction(data) {
    if (!data.businessId || !data.transactionDate || !data.amount) {
      throw new Error('Missing required fields for transaction');
    }
    return this.create(data);
  }

  /**
   * Find a transaction by ID and business ID (with populated account details).
   * @param {string} id
   * @param {string} businessId
   * @returns {Promise<Object|null>}
   */
  async findByIdWithDetails(id, businessId) {
    const validId = sanitizeAndValidateId(id);
    const validBusinessId = sanitizeAndValidateId(businessId);
    return this.model.findOne({
      _id: validId,
      businessId: validBusinessId,
      isArchived: { $ne: true },
    })
      .populate('debitAccountId', 'accountName accountType normalBalance')
      .populate('creditAccountId', 'accountName accountType normalBalance')
      .populate('createdBy', 'fullName email')
      .populate('reversalOf')
      .populate('customerId', 'fullName businessName email currentReceivableBalance')
      .populate('vendorId', 'vendorName contactPerson email currentPayableBalance')
      .populate('parentTransactionId', 'description amount transactionDate paymentStatus remainingBalance')
      .populate('installmentPlanId')
      .lean();
  }

  /**
   * Find transactions with advanced filtering and pagination.
   * Extended to support customer, vendor, payment status filters.
   * @param {string} businessId
   * @param {Object} filters
   * @param {Object} pagination
   * @returns {Promise<{data: Array, total: number, page: number, limit: number}>}
   */
  async findManyWithFilters(businessId, filters = {}, pagination = {}) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const {
      page = 1,
      limit = 25,
      sortBy = 'transactionDate',
      sortOrder = -1,
    } = pagination;
    const skip = (page - 1) * limit;

    const query = {
      businessId: validBusinessId,
      isArchived: { $ne: true },
    };

    // Date range
    if (filters.startDate || filters.endDate) {
      query.transactionDate = {};
      if (filters.startDate) query.transactionDate.$gte = new Date(filters.startDate);
      if (filters.endDate) query.transactionDate.$lte = new Date(filters.endDate);
    }

    // Transaction type
    if (filters.transactionType && Object.values(TRANSACTION_TYPES).includes(filters.transactionType)) {
      query.transactionType = filters.transactionType;
    }

    // Amount range
    if (filters.minAmount !== undefined || filters.maxAmount !== undefined) {
      query.amount = {};
      if (filters.minAmount !== undefined) query.amount.$gte = parseFloat(filters.minAmount);
      if (filters.maxAmount !== undefined) query.amount.$lte = parseFloat(filters.maxAmount);
    }

    // Account filter (looks at either debit or credit account)
    if (filters.accountId) {
      const validAccountId = sanitizeAndValidateId(filters.accountId);
      query.$or = [
        { debitAccountId: validAccountId },
        { creditAccountId: validAccountId },
      ];
    }

    // Status (posted/reversed/etc)
    if (filters.status && Object.values(JOURNAL_STATUS).includes(filters.status)) {
      query.status = filters.status;
    }

    // Payment status filter (v2)
    if (filters.paymentStatus && Object.values(PAYMENT_STATUS).includes(filters.paymentStatus)) {
      query.paymentStatus = filters.paymentStatus;
    }

    // Customer filter (v2)
    if (filters.customerId) {
      query.customerId = sanitizeAndValidateId(filters.customerId);
    }

    // Vendor filter (v2)
    if (filters.vendorId) {
      query.vendorId = sanitizeAndValidateId(filters.vendorId);
    }

    // Outstanding balance filter (v2)
    if (filters.hasOutstandingBalance === true || filters.hasOutstandingBalance === 'true') {
      query.remainingBalance = { $gt: 0 };
      query.paymentStatus = { $in: [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PARTIALLY_PAID] };
    }

    // Keyword search in description
    if (filters.search) {
      query.description = { $regex: filters.search, $options: 'i' };
    }

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder;

    try {
      const data = await this.model.find(query)
        .populate('debitAccountId', 'accountName')
        .populate('creditAccountId', 'accountName')
        .populate('customerId', 'fullName businessName')
        .populate('vendorId', 'vendorName')
        .sort(sortOptions)
        .skip(skip)
        .limit(limit)
        .lean();
      const total = await this.model.countDocuments(query);
      return { data, total, page, limit };
    } catch (error) {
      logger.error('Error filtering transactions:', error);
      throw new Error(`Failed to fetch transactions: ${error.message}`);
    }
  }

  /**
   * Update a transaction by ID and business ID.
   * @param {string} id
   * @param {string} businessId
   * @param {Object} updateData
   * @returns {Promise<Object|null>}
   */
  async updateTransaction(id, businessId, updateData) {
    const validId = sanitizeAndValidateId(id);
    const validBusinessId = sanitizeAndValidateId(businessId);
    return this.model.findOneAndUpdate(
      { _id: validId, businessId: validBusinessId },
      { ...updateData, updatedAt: new Date() },
      { new: true, runValidators: true }
    ).exec();
  }

  /**
   * Permanently delete a transaction (use only for reversal in service layer).
   * @param {string} id
   * @param {string} businessId
   * @returns {Promise<Object|null>}
   */
  async deletePermanent(id, businessId) {
    const validId = sanitizeAndValidateId(id);
    const validBusinessId = sanitizeAndValidateId(businessId);
    const result = await this.model.findOneAndDelete({
      _id: validId,
      businessId: validBusinessId,
    }).exec();
    logger.warn(`Transaction ${id} permanently deleted (business ${businessId})`);
    return result;
  }

  /**
   * Get all posted transactions within a date range (for report generation).
   * Updated to include all active statuses.
   * @param {string} businessId
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {Promise<Array>}
   */
  async getByDateRange(businessId, startDate, endDate) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    return this.model.find({
      businessId: validBusinessId,
      transactionDate: { $gte: startDate, $lte: endDate },
      status: { $in: [JOURNAL_STATUS.POSTED, JOURNAL_STATUS.PARTIALLY_SETTLED, JOURNAL_STATUS.SETTLED] },
      isArchived: { $ne: true },
    })
      .populate('debitAccountId creditAccountId')
      .sort({ transactionDate: 1 })
      .lean();
  }

  /**
   * Get all transactions that affect a specific account (for ledger).
   * @param {string} businessId
   * @param {string} accountId
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {Promise<Array>}
   */
  async getByAccount(businessId, accountId, startDate, endDate) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const validAccountId = sanitizeAndValidateId(accountId);
    return this.model.find({
      businessId: validBusinessId,
      transactionDate: { $gte: startDate, $lte: endDate },
      status: { $in: [JOURNAL_STATUS.POSTED, JOURNAL_STATUS.PARTIALLY_SETTLED, JOURNAL_STATUS.SETTLED] },
      isArchived: { $ne: true },
      $or: [
        { debitAccountId: validAccountId },
        { creditAccountId: validAccountId },
      ],
    })
      .sort({ transactionDate: 1 })
      .lean();
  }

  // ===============================
  // New v2 Query Methods
  // ===============================

  /**
   * Find all transactions for a specific customer.
   * @param {string} businessId
   * @param {string} customerId
   * @param {Object} filters - Optional date/status filters
   * @param {Object} pagination
   * @returns {Promise<{data: Array, total: number, page: number, limit: number}>}
   */
  async findByCustomer(businessId, customerId, filters = {}, pagination = {}) {
    return this.findManyWithFilters(
      businessId,
      { ...filters, customerId },
      pagination
    );
  }

  /**
   * Find all transactions for a specific vendor.
   * @param {string} businessId
   * @param {string} vendorId
   * @param {Object} filters
   * @param {Object} pagination
   * @returns {Promise<{data: Array, total: number, page: number, limit: number}>}
   */
  async findByVendor(businessId, vendorId, filters = {}, pagination = {}) {
    return this.findManyWithFilters(
      businessId,
      { ...filters, vendorId },
      pagination
    );
  }

  /**
   * Find all child transactions (payments) linked to a parent transaction.
   * @param {string} parentTransactionId
   * @param {string} businessId
   * @returns {Promise<Array>}
   */
  async findByParentTransaction(parentTransactionId, businessId) {
    const validParentId = sanitizeAndValidateId(parentTransactionId);
    const validBusinessId = sanitizeAndValidateId(businessId);
    return this.model.find({
      parentTransactionId: validParentId,
      businessId: validBusinessId,
      isArchived: { $ne: true },
    })
      .populate('debitAccountId', 'accountName')
      .populate('creditAccountId', 'accountName')
      .sort({ transactionDate: 1 })
      .lean();
  }

  /**
   * Get outstanding receivables (unpaid/partially paid transactions with customerIds).
   * @param {string} businessId
   * @returns {Promise<Array>}
   */
  async getOutstandingReceivables(businessId) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    return this.model.find({
      businessId: validBusinessId,
      customerId: { $ne: null },
      paymentStatus: { $in: [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PARTIALLY_PAID, PAYMENT_STATUS.OVERDUE] },
      remainingBalance: { $gt: 0 },
      isArchived: { $ne: true },
    })
      .populate('customerId', 'fullName businessName')
      .populate('debitAccountId', 'accountName')
      .populate('creditAccountId', 'accountName')
      .sort({ dueDate: 1 })
      .lean();
  }

  /**
   * Get outstanding payables (unpaid/partially paid transactions with vendorIds).
   * @param {string} businessId
   * @returns {Promise<Array>}
   */
  async getOutstandingPayables(businessId) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    return this.model.find({
      businessId: validBusinessId,
      vendorId: { $ne: null },
      paymentStatus: { $in: [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PARTIALLY_PAID, PAYMENT_STATUS.OVERDUE] },
      remainingBalance: { $gt: 0 },
      isArchived: { $ne: true },
    })
      .populate('vendorId', 'vendorName contactPerson')
      .populate('debitAccountId', 'accountName')
      .populate('creditAccountId', 'accountName')
      .sort({ dueDate: 1 })
      .lean();
  }

  // ===============================
  // Aggregation Pipelines (preserved from v1)
  // ===============================

  /**
   * Aggregation pipeline for Income Statement.
   * Returns revenue and expense totals grouped by account.
   */
  async getIncomeStatementData(businessId, startDate, endDate) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const pipeline = [
      {
        $match: {
          businessId: validBusinessId,
          transactionDate: { $gte: startDate, $lte: endDate },
          status: { $in: [JOURNAL_STATUS.POSTED, JOURNAL_STATUS.PARTIALLY_SETTLED, JOURNAL_STATUS.SETTLED] },
          isArchived: { $ne: true },
        },
      },
      {
        $lookup: {
          from: 'chartofaccounts',
          localField: 'debitAccountId',
          foreignField: '_id',
          as: 'debitAccount',
        },
      },
      {
        $lookup: {
          from: 'chartofaccounts',
          localField: 'creditAccountId',
          foreignField: '_id',
          as: 'creditAccount',
        },
      },
      { $unwind: { path: '$debitAccount', preserveNullAndEmptyArrays: true } },
      { $unwind: { path: '$creditAccount', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: null,
          revenueEntries: {
            $push: {
              $cond: [
                { $eq: ['$creditAccount.accountType', 'Revenue'] },
                { amount: '$amount', accountName: '$creditAccount.accountName' },
                null,
              ],
            },
          },
          expenseEntries: {
            $push: {
              $cond: [
                { $eq: ['$debitAccount.accountType', 'Expense'] },
                { amount: '$amount', accountName: '$debitAccount.accountName' },
                null,
              ],
            },
          },
        },
      },
    ];

    const result = await this.model.aggregate(pipeline);
    if (result.length === 0) {
      return { revenue: [], expenses: [] };
    }

    const revenueMap = new Map();
    const expenseMap = new Map();

    result[0].revenueEntries.forEach(entry => {
      if (entry && entry.accountName) {
        const key = entry.accountName;
        revenueMap.set(key, (revenueMap.get(key) || 0) + entry.amount);
      }
    });
    result[0].expenseEntries.forEach(entry => {
      if (entry && entry.accountName) {
        const key = entry.accountName;
        expenseMap.set(key, (expenseMap.get(key) || 0) + entry.amount);
      }
    });

    const revenue = Array.from(revenueMap, ([name, amount]) => ({ name, amount }));
    const expenses = Array.from(expenseMap, ([name, amount]) => ({ name, amount }));

    return { revenue, expenses };
  }

  /**
   * Aggregation pipeline for Balance Sheet (stub — service uses account repository).
   */
  async getBalanceSheetData(businessId, asOfDate) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const pipeline = [
      {
        $match: {
          businessId: validBusinessId,
          transactionDate: { $lte: asOfDate },
          status: { $in: [JOURNAL_STATUS.POSTED, JOURNAL_STATUS.PARTIALLY_SETTLED, JOURNAL_STATUS.SETTLED] },
          isArchived: { $ne: true },
        },
      },
      {
        $facet: {
          assetChanges: [
            { $match: { debitAccountType: 'Asset' } },
            { $group: { _id: '$debitAccountId', total: { $sum: '$amount' } } },
          ],
          liabilityChanges: [
            { $match: { creditAccountType: 'Liability' } },
            { $group: { _id: '$creditAccountId', total: { $sum: '$amount' } } },
          ],
          equityChanges: [
            { $match: { creditAccountType: 'Equity' } },
            { $group: { _id: '$creditAccountId', total: { $sum: '$amount' } } },
          ],
        },
      },
    ];
    const result = await this.model.aggregate(pipeline);
    return { assets: [], liabilities: [], equity: [] };
  }

  /**
   * Bulk create transactions (for Excel import).
   */
  async bulkCreate(entriesArray) {
    if (!entriesArray || entriesArray.length === 0) return [];
    return this.model.insertMany(entriesArray, { ordered: false });
  }

  /**
   * Get reversal entries for a given transaction.
   */
  async getReversalEntries(transactionId, businessId) {
    const validId = sanitizeAndValidateId(transactionId);
    const validBusinessId = sanitizeAndValidateId(businessId);
    return this.model.find({
      reversalOf: validId,
      businessId: validBusinessId,
    }).lean();
  }
}

module.exports = new TransactionRepository();
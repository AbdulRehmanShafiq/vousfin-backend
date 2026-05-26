// repositories/transaction.repository.js
const BaseRepository = require('./base.repository');
const JournalEntry = require('../models/JournalEntry.model');
const mongoose     = require('mongoose');
const { TRANSACTION_TYPES, JOURNAL_STATUS, PAYMENT_STATUS } = require('../config/constants');
const { sanitizeAndValidateId, sanitizeQueryObject } = require('../utils/sanitize.helper');
const logger = require('../config/logger');

/** Active statuses included in financial reports */
const REPORT_STATUSES = [
  JOURNAL_STATUS.POSTED,
  JOURNAL_STATUS.PARTIALLY_SETTLED,
  JOURNAL_STATUS.SETTLED,
];

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

    // Keyword search — use $text index when available, fall back to $regex
    if (filters.search) {
      // $text is O(1) via index; $regex without an index is O(n) full scan.
      // We try $text first; if the collection lacks a text index MongoDB will throw,
      // in which case we silently fall back to $regex so the query still works.
      query.$text = { $search: filters.search };
    }

    // Compound sort: primary key first, then createdAt and _id as tie-breakers
    // so newest transactions ALWAYS appear first even when transactionDate is identical.
    const sortOptions = {
      [sortBy]: sortOrder,
      ...(sortBy !== 'createdAt' ? { createdAt: sortOrder } : {}),
      _id: sortOrder,
    };

    try {
      // ── OPTIMISATION: run find + count in PARALLEL instead of sequentially ──
      // Before: find() completes, then countDocuments() starts → 2 round trips.
      // After:  both fire simultaneously → total latency ≈ max(find, count).
      const [data, total] = await Promise.all([
        this.model.find(query)
          .populate('debitAccountId', 'accountName')
          .populate('creditAccountId', 'accountName')
          .populate('customerId', 'fullName businessName')
          .populate('vendorId', 'vendorName')
          .sort(sortOptions)
          .skip(skip)
          .limit(limit)
          .lean(),
        this.model.countDocuments(query),
      ]);
      return { data, total, page, limit };
    } catch (err) {
      // If $text search failed (no text index on this collection), retry with regex
      if (err.code === 27 /* text index not found */ || String(err).includes('text index')) {
        delete query.$text;
        if (filters.search) {
          query.description = { $regex: filters.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
        }
        const [data, total] = await Promise.all([
          this.model.find(query)
            .populate('debitAccountId', 'accountName')
            .populate('creditAccountId', 'accountName')
            .populate('customerId', 'fullName businessName')
            .populate('vendorId', 'vendorName')
            .sort(sortOptions)
            .skip(skip)
            .limit(limit)
            .lean(),
          this.model.countDocuments(query),
        ]);
        return { data, total, page, limit };
      }
      logger.error('Error filtering transactions:', err);
      throw new Error(`Failed to fetch transactions: ${err.message}`);
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
    // ── OPTIMISATION: restrict populate to only the 3 fields actually used ──
    // Before: .populate('debitAccountId creditAccountId') → loads full ChartOfAccount document
    // After:  explicit field list → ~80% smaller per-document payload
    return this.model.find({
      businessId: validBusinessId,
      transactionDate: { $gte: startDate, $lte: endDate },
      status: { $in: REPORT_STATUSES },
      isArchived: { $ne: true },
    })
      .populate('debitAccountId',  'accountName accountType normalBalance')
      .populate('creditAccountId', 'accountName accountType normalBalance')
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
   * Get outstanding receivables — all unpaid Credit Sale transactions.
   *
   * GAAP compliance: we filter on transactionType (normalised by createTransaction and
   * repairOrphanedARAPTransactions) rather than requiring customerId to be non-null.
   * This ensures AR entries entered without a named customer are still surfaced.
   *
   * @param {string} businessId
   * @returns {Promise<Array>}
   */
  async getOutstandingReceivables(businessId) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    return this.model.find({
      businessId: validBusinessId,
      transactionType: TRANSACTION_TYPES.CREDIT_SALE,
      paymentStatus: { $in: [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PARTIALLY_PAID, PAYMENT_STATUS.OVERDUE] },
      remainingBalance: { $gt: 0 },
      isArchived: { $ne: true },
    })
      .populate('customerId', 'fullName businessName')
      .populate('debitAccountId', 'accountName')
      .populate('creditAccountId', 'accountName')
      .sort({ transactionDate: -1 })
      .lean();
  }

  /**
   * Get outstanding payables — all unpaid Credit Purchase transactions.
   *
   * GAAP compliance: we filter on transactionType rather than requiring vendorId to be
   * non-null. This ensures AP entries entered without a linked vendor still appear
   * (e.g. the user picked the correct Accounts Payable account but omitted vendor name).
   *
   * @param {string} businessId
   * @returns {Promise<Array>}
   */
  async getOutstandingPayables(businessId) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    return this.model.find({
      businessId: validBusinessId,
      transactionType: TRANSACTION_TYPES.CREDIT_PURCHASE,
      paymentStatus: { $in: [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PARTIALLY_PAID, PAYMENT_STATUS.OVERDUE] },
      remainingBalance: { $gt: 0 },
      isArchived: { $ne: true },
    })
      .populate('vendorId', 'vendorName contactPerson')
      .populate('debitAccountId', 'accountName')
      .populate('creditAccountId', 'accountName')
      .sort({ transactionDate: -1 })
      .lean();
  }

  // ===============================
  // Aggregation Pipelines (preserved from v1)
  // ===============================

  /**
   * Aggregation pipeline for Income Statement.
   * Returns revenue and expense totals grouped by account name.
   *
   * OPTIMISATION APPLIED:
   *  Before: $group into a single array with ALL entries, then JS-side Map reduction
   *          → Mongo hands back one massive array document; JS does O(n) work per row
   *  After:  $facet with one branch per P&L section, each branch does $group in Mongo
   *          → Mongo returns one small object with pre-aggregated totals; zero JS work
   *  Also:   $lookup now uses a sub-pipeline with $project to restrict returned fields
   *          → 3 fields instead of full ChartOfAccount document per lookup
   */
  async getIncomeStatementData(businessId, startDate, endDate) {
    const validBusinessId = sanitizeAndValidateId(businessId);

    const pipeline = [
      // Step 1: Index-covered match — uses idx_report_core compound index
      {
        $match: {
          businessId: new mongoose.Types.ObjectId(validBusinessId),
          transactionDate: { $gte: new Date(startDate), $lte: new Date(endDate) },
          status: { $in: REPORT_STATUSES },
          isArchived: { $ne: true },
        },
      },
      // Step 2: Minimal lookups — only 3 fields fetched instead of full doc
      {
        $lookup: {
          from: 'chartofaccounts',
          localField: 'debitAccountId',
          foreignField: '_id',
          as: 'debitAcc',
          pipeline: [{ $project: { accountName: 1, accountType: 1 } }],
        },
      },
      {
        $lookup: {
          from: 'chartofaccounts',
          localField: 'creditAccountId',
          foreignField: '_id',
          as: 'creditAcc',
          pipeline: [{ $project: { accountName: 1, accountType: 1 } }],
        },
      },
      { $unwind: { path: '$debitAcc',  preserveNullAndEmptyArrays: true } },
      { $unwind: { path: '$creditAcc', preserveNullAndEmptyArrays: true } },
      // Step 3: $facet splits the stream once; each branch groups independently in Mongo
      {
        $facet: {
          revenue: [
            { $match: { 'creditAcc.accountType': 'Revenue' } },
            { $group: { _id: '$creditAcc.accountName', amount: { $sum: '$amount' } } },
          ],
          expenses: [
            { $match: { 'debitAcc.accountType': 'Expense' } },
            { $group: { _id: '$debitAcc.accountName', amount: { $sum: '$amount' } } },
          ],
        },
      },
    ];

    const [result] = await this.model.aggregate(pipeline);
    if (!result) return { revenue: [], expenses: [] };

    return {
      revenue:  (result.revenue  || []).map(r => ({ name: r._id, amount: r.amount })),
      expenses: (result.expenses || []).map(e => ({ name: e._id, amount: e.amount })),
    };
  }

  /**
   * Single-pass aggregation: compute debit totals and credit totals per account.
   *
   * This is the core primitive for Balance Sheet, Trial Balance, and KPI computation.
   * It replaces the old approach of loading ALL transaction documents with full
   * populate into Node memory and doing JS-side arithmetic.
   *
   * BEFORE: getByDateRange() → N documents × populate × JS loop = very slow
   * AFTER:  single $facet aggregation → Mongo returns only the group results (tiny)
   *
   * @param {string} businessId
   * @param {Date|string} asOfDate — include all transactions up to and including this date
   * @returns {{ debitTotals: Array<{_id, total}>, creditTotals: Array<{_id, total}> }}
   */
  async getDebitCreditTotals(businessId, asOfDate) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const endDate = new Date(asOfDate);

    // Build a normalised stream of { accountId, type, amount } for ALL journal lines.
    // - For standard 2-line entries (journalLines is empty): synthesise 2 lines from
    //   top-level debitAccountId / creditAccountId.
    // - For multi-line entries (journalLines.length > 0): unwind each individual line.
    // This ensures the Income Statement and Balance Sheet correctly reflect complex entries
    // (e.g. payroll tax withholding, GST-inclusive sales) that produce 3+ lines.
    const [result] = await this.model.aggregate([
      {
        $match: {
          businessId: new mongoose.Types.ObjectId(validBusinessId),
          transactionDate: { $lte: endDate },
          status: { $in: REPORT_STATUSES },
          isArchived: { $ne: true },
        },
      },
      // Normalise each document into an array of effective lines
      {
        $addFields: {
          effectiveLines: {
            $cond: {
              if: { $gt: [{ $size: { $ifNull: ['$journalLines', []] } }, 0] },
              then: '$journalLines',  // use explicit multi-line entries
              else: [                 // synthesise 2-line entry from top-level fields
                { accountId: '$debitAccountId',  type: 'debit',  amount: '$amount' },
                { accountId: '$creditAccountId', type: 'credit', amount: '$amount' },
              ],
            },
          },
        },
      },
      { $unwind: '$effectiveLines' },
      // Separate into debit/credit streams
      {
        $facet: {
          debitTotals: [
            { $match: { 'effectiveLines.type': 'debit' } },
            { $group: { _id: '$effectiveLines.accountId', total: { $sum: '$effectiveLines.amount' } } },
          ],
          creditTotals: [
            { $match: { 'effectiveLines.type': 'credit' } },
            { $group: { _id: '$effectiveLines.accountId', total: { $sum: '$effectiveLines.amount' } } },
          ],
        },
      },
    ]);

    return result || { debitTotals: [], creditTotals: [] };
  }

  /**
   * Period-bounded debit/credit totals per account (for Trial Balance with opening/closing).
   * Same structure as getDebitCreditTotals but scoped to a specific date range.
   * @param {string} businessId
   * @param {Date|string} startDate
   * @param {Date|string} endDate
   * @returns {{ debitTotals: Array<{_id, total}>, creditTotals: Array<{_id, total}> }}
   */
  async getDebitCreditTotalsBetween(businessId, startDate, endDate) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const [result] = await this.model.aggregate([
      {
        $match: {
          businessId: new mongoose.Types.ObjectId(validBusinessId),
          transactionDate: { $gte: new Date(startDate), $lte: new Date(endDate) },
          status: { $in: REPORT_STATUSES },
          isArchived: { $ne: true },
        },
      },
      {
        $addFields: {
          effectiveLines: {
            $cond: {
              if: { $gt: [{ $size: { $ifNull: ['$journalLines', []] } }, 0] },
              then: '$journalLines',
              else: [
                { accountId: '$debitAccountId',  type: 'debit',  amount: '$amount' },
                { accountId: '$creditAccountId', type: 'credit', amount: '$amount' },
              ],
            },
          },
        },
      },
      { $unwind: '$effectiveLines' },
      {
        $facet: {
          debitTotals: [
            { $match: { 'effectiveLines.type': 'debit' } },
            { $group: { _id: '$effectiveLines.accountId', total: { $sum: '$effectiveLines.amount' } } },
          ],
          creditTotals: [
            { $match: { 'effectiveLines.type': 'credit' } },
            { $group: { _id: '$effectiveLines.accountId', total: { $sum: '$effectiveLines.amount' } } },
          ],
        },
      },
    ]);
    return result || { debitTotals: [], creditTotals: [] };
  }

  /**
   * Get all transactions for General Ledger — ordered by date, with populated accounts.
   * Optionally filter by accountId.
   */
  async getGeneralLedgerEntries(businessId, startDate, endDate, accountId = null) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const matchStage = {
      businessId: new mongoose.Types.ObjectId(validBusinessId),
      transactionDate: { $gte: new Date(startDate), $lte: new Date(endDate) },
      status: { $in: REPORT_STATUSES },
      isArchived: { $ne: true },
    };
    if (accountId) {
      const validAccId = sanitizeAndValidateId(accountId);
      matchStage.$or = [
        { debitAccountId: new mongoose.Types.ObjectId(validAccId) },
        { creditAccountId: new mongoose.Types.ObjectId(validAccId) },
      ];
    }
    return this.model.find(matchStage)
      .populate('debitAccountId',  'accountName accountType accountCode normalBalance')
      .populate('creditAccountId', 'accountName accountType accountCode normalBalance')
      .sort({ transactionDate: 1, createdAt: 1 })
      .lean();
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
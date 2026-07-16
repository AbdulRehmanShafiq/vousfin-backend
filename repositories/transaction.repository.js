// repositories/transaction.repository.js
const BaseRepository = require('./base.repository');
const JournalEntry = require('../models/JournalEntry.model');
const mongoose     = require('mongoose');
const { TRANSACTION_TYPES, JOURNAL_STATUS, PAYMENT_STATUS } = require('../config/constants');
const { sanitizeAndValidateId, sanitizeQueryObject } = require('../utils/sanitize.helper');
const logger = require('../config/logger');

/**
 * Statuses included in financial reports.
 *
 * 'reversed' MUST be included (audit 2026-07-02 F1): a reversed ORIGINAL keeps
 * status 'reversed' while its counter-entry posts as 'posted'. Excluding the
 * original would leave the flipped counter-entry in every statement with
 * nothing to offset it (Cash −100 instead of 0) and would retroactively remove
 * the original from its historical period. Enterprise GLs keep BOTH entries in
 * the reports — the pair nets to zero, each side in its own period — which also
 * matches how the cached running balances were applied (both postings moved
 * them; see ledgerIntegrity.BALANCE_STATUSES).
 */
const REPORT_STATUSES = [
  JOURNAL_STATUS.POSTED,
  JOURNAL_STATUS.PARTIALLY_SETTLED,
  JOURNAL_STATUS.SETTLED,
  JOURNAL_STATUS.REVERSED,
];

/**
 * Shared aggregation stage that normalises every journal entry into a uniform
 * array of `{ accountId, type, amount }` lines:
 *   • Compound entries (journalLines.length > 0) → use the explicit lines
 *     (these carry the COGS / tax legs that exist ONLY in journalLines).
 *   • Simple 2-account entries                   → synthesise debit + credit
 *     from the top-level debitAccountId / creditAccountId.
 *
 * This is the SINGLE source of line-normalisation reused by the Income Statement,
 * Balance Sheet and Trial Balance so the three statements can never disagree
 * about an entry's effect on the ledger. (Rule 4 — no duplicate logic.)
 */
const EFFECTIVE_LINES_STAGE = {
  $addFields: {
    effectiveLines: {
      $cond: {
        if: { $gt: [{ $size: { $ifNull: ['$journalLines', []] } }, 0] },
        then: '$journalLines',
        else: [
          // Synthesise the 2-account pair in the REPORTING (base) currency. For a
          // foreign-currency entry the top-level `amount` is the original foreign
          // amount (kept for display); the ledger effect is `baseCurrencyAmount`.
          // Using base here keeps the Trial Balance / statements / ledger-integrity
          // verifier in the functional currency, matching how balances were posted.
          { accountId: '$debitAccountId',  type: 'debit',  amount: { $ifNull: ['$baseCurrencyAmount', '$amount'] } },
          { accountId: '$creditAccountId', type: 'credit', amount: { $ifNull: ['$baseCurrencyAmount', '$amount'] } },
        ],
      },
    },
  },
};

class TransactionRepository extends BaseRepository {
  constructor() {
    super(JournalEntry);
  }

  /**
   * Create a new journal entry.
   * @param {Object} data - Journal entry data
   * @returns {Promise<Object>}
   */
  async createTransaction(data, session = null) {
    if (!data.businessId || !data.transactionDate || !data.amount) {
      throw new Error('Missing required fields for transaction');
    }
    if (session) {
      // Save inside the caller's all-or-nothing transaction.
      const doc = new this.model(data);
      return doc.save({ session });
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
  async updateTransaction(id, businessId, updateData, session = null) {
    const validId = sanitizeAndValidateId(id);
    const validBusinessId = sanitizeAndValidateId(businessId);
    const options = { new: true, runValidators: true };
    if (session) options.session = session; // join an all-or-nothing transaction when given
    return this.model.findOneAndUpdate(
      { _id: validId, businessId: validBusinessId },
      { ...updateData, updatedAt: new Date() },
      options
    ).exec();
  }

  /**
   * Optimistically-guarded update (audit 2026-07-02 F5). Adds the caller's
   * `match` conditions to the filter so the write only lands if the document
   * still looks the way the caller read it (e.g. `{ remainingBalance: 600 }`).
   * Returns null when the guard misses — the caller lost a concurrent race and
   * must NOT apply its precomputed values.
   *
   * @param {string} id
   * @param {string} businessId
   * @param {Object} match       extra filter conditions (the optimistic guard)
   * @param {Object} updateData
   * @param {import('mongoose').ClientSession|null} [session]
   * @returns {Promise<Object|null>} the updated doc, or null if the guard missed
   */
  async updateTransactionGuarded(id, businessId, match, updateData, session = null) {
    const validId = sanitizeAndValidateId(id);
    const validBusinessId = sanitizeAndValidateId(businessId);
    const options = { new: true, runValidators: true };
    if (session) options.session = session;
    return this.model.findOneAndUpdate(
      { _id: validId, businessId: validBusinessId, ...match },
      { ...updateData, updatedAt: new Date() },
      options
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
      status: { $in: REPORT_STATUSES },
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
    // Primary clause: correctly classified Credit Sale (set by GAAP detection in createTransaction).
    // Legacy clause: entries where step-3 auto-inference stored 'Income' as the type
    // but the GAAP detection later set paymentStatus, meaning the AR detection fired
    // but the type override was not persisted (a pre-2026-06 code edge case).
    // Using 'Income' (not a generic NOT-IN) keeps this mutually exclusive from the
    // AP query (which uses 'Expense') — so there is no double-counting across queries.
    return this.model.find({
      businessId: validBusinessId,
      $or: [
        { transactionType: TRANSACTION_TYPES.CREDIT_SALE },
        {
          transactionType: 'Income',
          paymentStatus: { $in: [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PARTIALLY_PAID, PAYMENT_STATUS.OVERDUE] },
        },
      ],
      paymentStatus: { $in: [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PARTIALLY_PAID, PAYMENT_STATUS.OVERDUE] },
      remainingBalance: { $gt: 0 },
      // Projection JEs (invoice-first) never track a balance, so the two
      // clauses above already exclude them — this filter is the standing
      // declaration that the DOCUMENT owns those items (spec 2026-07-16).
      isProjection: { $ne: true },
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
    // Primary clause: correctly classified Credit Purchase (set by GAAP detection).
    // Legacy clause: entries where step-3 auto-inference stored 'Expense' as the type
    // but the GAAP detection later set paymentStatus on the AP side — a pre-2026-06
    // edge case. Using 'Expense' keeps this mutually exclusive from the AR query
    // (which uses 'Income') — so there is no double-counting across queries.
    return this.model.find({
      businessId: validBusinessId,
      $or: [
        { transactionType: TRANSACTION_TYPES.CREDIT_PURCHASE },
        {
          transactionType: 'Expense',
          paymentStatus: { $in: [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PARTIALLY_PAID, PAYMENT_STATUS.OVERDUE] },
        },
      ],
      paymentStatus: { $in: [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PARTIALLY_PAID, PAYMENT_STATUS.OVERDUE] },
      remainingBalance: { $gt: 0 },
      // Same standing declaration as the receivables query (spec 2026-07-16).
      isProjection: { $ne: true },
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

    // The Income Statement must reflect EVERY journal line — including the COGS /
    // tax legs that live ONLY in journalLines on compound entries. We therefore
    // normalise with the SAME effective-lines stage the Trial Balance / Balance
    // Sheet use (getDebitCreditTotals), then classify each line by its account
    // type. Previously this read only the top-level debit/credit accounts, so a
    // transaction-first inventory sale's COGS (held in journalLines) was invisible
    // to the P&L while still hitting the Balance Sheet — the two disagreed.
    //
    // Convention (audit 2026-07-02 F1 — NET movement):
    //   • Revenue = Σ credit lines − Σ debit lines on Revenue accounts
    //   • Expense = Σ debit lines − Σ credit lines on Expense accounts
    //     (COGS accounts are accountType 'Expense', subtype 'Direct Cost')
    // The old gross convention (credit-only / debit-only) ignored a reversal's
    // contra leg, so reversing a sale never reduced the P&L. Netting fixes that,
    // but it means system closing / opening-balance sweeps (which the gross
    // convention excluded "naturally") must now be excluded EXPLICITLY by
    // entryType. Adjusting entries stay in — accruals/depreciation belong on
    // the P&L.
    const pipeline = [
      {
        $match: {
          businessId: new mongoose.Types.ObjectId(validBusinessId),
          transactionDate: { $gte: new Date(startDate), $lte: new Date(endDate) },
          status: { $in: REPORT_STATUSES },
          entryType: { $nin: ['closing', 'opening_balance'] },
          isArchived: { $ne: true },
        },
      },
      EFFECTIVE_LINES_STAGE,
      { $unwind: '$effectiveLines' },
      {
        $lookup: {
          from: 'chartofaccounts',
          localField: 'effectiveLines.accountId',
          foreignField: '_id',
          as: 'acc',
          pipeline: [{ $project: { accountName: 1, accountType: 1 } }],
        },
      },
      { $unwind: { path: '$acc', preserveNullAndEmptyArrays: true } },
      {
        $facet: {
          revenue: [
            { $match: { 'acc.accountType': 'Revenue' } },
            {
              $group: {
                _id: '$acc.accountName',
                amount: {
                  $sum: {
                    $cond: [
                      { $eq: ['$effectiveLines.type', 'credit'] },
                      '$effectiveLines.amount',
                      { $multiply: ['$effectiveLines.amount', -1] },
                    ],
                  },
                },
              },
            },
          ],
          expenses: [
            { $match: { 'acc.accountType': 'Expense' } },
            {
              $group: {
                _id: '$acc.accountName',
                amount: {
                  $sum: {
                    $cond: [
                      { $eq: ['$effectiveLines.type', 'debit'] },
                      '$effectiveLines.amount',
                      { $multiply: ['$effectiveLines.amount', -1] },
                    ],
                  },
                },
              },
            },
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
   * @param {Object} [opts]
   * @param {string[]} [opts.statuses] — override the status filter. Defaults to
   *   REPORT_STATUSES (what the financial statements show). The ledger-integrity
   *   verifier passes the balance-affecting set (incl. 'reversed') so a reversed
   *   original + its reversal net to zero — matching how the cached running
   *   balance applied BOTH postings.
   * @returns {{ debitTotals: Array<{_id, total}>, creditTotals: Array<{_id, total}> }}
   */
  async getDebitCreditTotals(businessId, asOfDate, { statuses = REPORT_STATUSES } = {}) {
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
          status: { $in: statuses },
          isArchived: { $ne: true },
        },
      },
      // Normalise each document into an array of effective lines (shared stage)
      EFFECTIVE_LINES_STAGE,
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
      EFFECTIVE_LINES_STAGE,
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
   * F15 — line-level net cash movement per transaction type, for the Cash Flow
   * Statement. Uses the SAME effective-lines normalisation as the other
   * statements, so cash legs living only inside compound journalLines (payroll
   * runs, taxed sales) are counted, a cash→cash transfer nets to zero, and
   * reversal pairs cancel (REPORT_STATUSES includes 'reversed').
   *
   * @param {string} businessId
   * @param {Array<string|Object>} cashAccountIds
   * @param {Date|string} startDate
   * @param {Date|string} endDate
   * @returns {Promise<Array<{_id: string, cashIn: number, cashOut: number}>>}
   */
  async getCashLineTotals(businessId, cashAccountIds, startDate, endDate) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const ids = (cashAccountIds || []).map((id) => new mongoose.Types.ObjectId(String(id._id || id)));
    return this.model.aggregate([
      {
        $match: {
          businessId: new mongoose.Types.ObjectId(validBusinessId),
          transactionDate: { $gte: new Date(startDate), $lte: new Date(endDate) },
          status: { $in: REPORT_STATUSES },
          isArchived: { $ne: true },
        },
      },
      EFFECTIVE_LINES_STAGE,
      { $unwind: '$effectiveLines' },
      { $match: { 'effectiveLines.accountId': { $in: ids } } },
      {
        $group: {
          _id: '$transactionType',
          cashIn:  { $sum: { $cond: [{ $eq: ['$effectiveLines.type', 'debit'] },  '$effectiveLines.amount', 0] } },
          cashOut: { $sum: { $cond: [{ $eq: ['$effectiveLines.type', 'credit'] }, '$effectiveLines.amount', 0] } },
        },
      },
    ]);
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

  // NOTE (audit 2026-07-02): the old `bulkCreate` (raw insertMany "for Excel
  // import") was removed — it had no callers and bypassed every model guard
  // (period locks, idempotency, balance updates). Bulk import goes through
  // transaction.service.createBulkTransactions → createTransaction, the one
  // pipeline every entry must use.

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

const transactionRepository = new TransactionRepository();
// Exported for unit tests asserting the Income Statement and Trial Balance share
// one line-normalisation stage (and therefore cannot diverge).
transactionRepository.EFFECTIVE_LINES_STAGE = EFFECTIVE_LINES_STAGE;
// Exported so variance/budget reads use the SAME statuses the financial
// statements show (posted / partially_settled / settled).
transactionRepository.REPORT_STATUSES = REPORT_STATUSES;
module.exports = transactionRepository;
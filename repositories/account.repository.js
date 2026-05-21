// repositories/account.repository.js
const BaseRepository = require('./base.repository');
const ChartOfAccount = require('../models/ChartOfAccount.model');
const { ACCOUNT_TYPES, DEFAULT_ACCOUNTS } = require('../config/constants');
const { sanitizeAndValidateId } = require('../utils/sanitize.helper');
const logger = require('../config/logger');

class AccountRepository extends BaseRepository {
  constructor() {
    super(ChartOfAccount);
  }

  /**
   * Find all accounts for a business, optionally filtered by account type.
   * @param {string} businessId
   * @param {string} accountType - Optional, e.g., 'Asset', 'Expense'
   * @returns {Promise<Array>}
   */
  async findByBusiness(businessId, accountType = null) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const query = { businessId: validBusinessId };
    if (accountType && Object.values(ACCOUNT_TYPES).includes(accountType)) {
      query.accountType = accountType;
    }
    return this.model.find(query).sort({ accountType: 1, accountName: 1 }).lean();
  }

  /**
   * Find an account by business and account name (case‑insensitive).
   * Used during Excel/NL import to resolve account names to IDs.
   * @param {string} businessId
   * @param {string} accountName
   * @returns {Promise<Object|null>}
   */
  async findByBusinessAndName(businessId, accountName) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    if (!accountName) return null;
    const cleanName = accountName.trim();

    // 1. Exact case-insensitive match
    const exact = await this.findOne({
      businessId: validBusinessId,
      accountName: { $regex: new RegExp(`^${cleanName}$`, 'i') },
    });
    if (exact) return exact;

    // 2. Partial / contains match — pick the closest by name length
    const partials = await this.model.find({
      businessId: validBusinessId,
      accountName: { $regex: new RegExp(cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
    }).lean();
    if (partials.length) return partials[0];

    // 3. Word-overlap fuzzy match — find the account with the most shared words
    const words = cleanName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (words.length) {
      const all = await this.model.find({ businessId: validBusinessId }).lean();
      let best = null, bestScore = 0;
      for (const acc of all) {
        const accWords = acc.accountName.toLowerCase().split(/\s+/);
        const score = words.filter(w => accWords.some(aw => aw.includes(w) || w.includes(aw))).length;
        if (score > bestScore) { bestScore = score; best = acc; }
      }
      if (bestScore > 0) return best;
    }

    return null;
  }

  /**
   * Find an account by business ID and account ID (ensures account belongs to business).
   * @param {string} businessId
   * @param {string} accountId
   * @returns {Promise<Object|null>}
   */
  async findOneByBusinessAndId(businessId, accountId) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const validAccountId = sanitizeAndValidateId(accountId);
    return this.findOne({
      _id: validAccountId,
      businessId: validBusinessId,
    });
  }

  /**
   * Update the running balance of an account by a delta.
   * @param {string} accountId
   * @param {number} delta - Positive or negative amount to add to current balance
   * @returns {Promise<Object|null>} Updated account
   */
  async updateRunningBalance(accountId, delta) {
    const validAccountId = sanitizeAndValidateId(accountId);
    if (typeof delta !== 'number' || isNaN(delta)) {
      throw new Error('Delta must be a number');
    }
    return this.model.findByIdAndUpdate(
      validAccountId,
      { $inc: { runningBalance: delta } },
      { new: true, runValidators: false }
    ).exec();
  }

  /**
   * Bulk insert default chart of accounts for a new business.
   * @param {string} businessId
   * @returns {Promise<Array>} Inserted accounts
   */
  async bulkCreateDefaultAccounts(businessId) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const accountsToInsert = DEFAULT_ACCOUNTS.map(acc => ({
      ...acc,
      businessId: validBusinessId,
      runningBalance: 0,
    }));
    try {
      const result = await this.model.insertMany(accountsToInsert);
      logger.info(`Inserted ${result.length} default accounts for business ${businessId}`);
      return result;
    } catch (error) {
      logger.error('Failed to insert default accounts:', error);
      throw new Error(`Could not seed default accounts: ${error.message}`);
    }
  }

  /**
   * Get total running balance for all accounts of a given type (e.g., total Assets).
   * Used in Balance Sheet generation.
   * @param {string} businessId
   * @param {string} accountType - 'Asset', 'Liability', 'Equity', 'Revenue', 'Expense'
   * @returns {Promise<number>}
   */
  async getTotalBalanceByType(businessId, accountType) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    if (!Object.values(ACCOUNT_TYPES).includes(accountType)) {
      throw new Error(`Invalid account type: ${accountType}`);
    }
    const result = await this.model.aggregate([
      { $match: { businessId: validBusinessId, accountType } },
      { $group: { _id: null, total: { $sum: '$runningBalance' } } },
    ]);
    return result.length > 0 ? result[0].total : 0;
  }

  /**
   * Get all accounts grouped by type with their balances (for balance sheet assembly).
   * @param {string} businessId
   * @returns {Promise<Object>} { Asset: [...], Liability: [...], Equity: [...], Revenue: [...], Expense: [...] }
   */
  async getGroupedByType(businessId) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const accounts = await this.model.find({ businessId: validBusinessId }).lean();
    const grouped = {
      Asset: [],
      Liability: [],
      Equity: [],
      Revenue: [],
      Expense: [],
    };
    accounts.forEach(acc => {
      if (grouped[acc.accountType]) {
        grouped[acc.accountType].push({
          _id: acc._id,
          accountName: acc.accountName,
          runningBalance: acc.runningBalance,
        });
      }
    });
    return grouped;
  }

  /**
   * Reset all running balances for a business to zero (admin/maintenance only).
   * @param {string} businessId
   * @returns {Promise<number>} Number of accounts updated
   */
  async resetAllRunningBalances(businessId) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const result = await this.model.updateMany(
      { businessId: validBusinessId },
      { $set: { runningBalance: 0 } }
    );
    logger.warn(`Reset running balances for ${result.modifiedCount} accounts (business ${businessId})`);
    return result.modifiedCount;
  }

  /**
   * Delete all accounts for a business (used when a business is permanently deleted).
   * @param {string} businessId
   * @returns {Promise<number>} Deleted count
   */
  async deleteByBusiness(businessId) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const result = await this.model.deleteMany({ businessId: validBusinessId });
    logger.info(`Deleted ${result.deletedCount} accounts for business ${businessId}`);
    return result.deletedCount;
  }
}

module.exports = new AccountRepository();
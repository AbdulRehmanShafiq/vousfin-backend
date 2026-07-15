// repositories/account.repository.js
const BaseRepository = require('./base.repository');
const ChartOfAccount = require('../models/ChartOfAccount.model');
const { ACCOUNT_TYPES, DEFAULT_ACCOUNTS, CONTROL_ACCOUNT_CODES } = require('../config/constants');
const { sanitizeAndValidateId } = require('../utils/sanitize.helper');
const { matchAccountByName } = require('../utils/accountMatcher');
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
   * Find an account by business and account name (case‑insensitive, fuzzy fallback).
   * Used during Excel/NL import to resolve account names to IDs.
   * Backward-compatible bare-account signature — existing callers unaffected.
   * @param {string} businessId
   * @param {string} accountName
   * @returns {Promise<Object|null>}
   */
  async findByBusinessAndName(businessId, accountName) {
    const { account } = await this.resolveWithConfidence(businessId, accountName);
    return account;
  }

  /**
   * Same lookup as findByBusinessAndName, but returns the match confidence and
   * matchType alongside the account — for callers that need to know HOW sure
   * the resolution is (NL parser account-mapping confidence, Excel per-row
   * scoring), not just the bare result.
   * @param {string} businessId
   * @param {string} accountName
   * @returns {Promise<{ account: Object|null, confidence: number, matchType: string }>}
   */
  async resolveWithConfidence(businessId, accountName) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const all = await this.model.find({ businessId: validBusinessId }).lean();
    return matchAccountByName(all, accountName);
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

  /** Find a business account by its (business-unique) accountCode. */
  async findByCode(businessId, accountCode) {
    return this.model.findOne({ businessId, accountCode }).lean();
  }

  /**
   * findById that can join a caller's transaction.
   *
   * BaseRepository.findById takes `populateFields` as its second argument, so it
   * cannot carry a session. The ledger poster needs one: it may be balancing an
   * account the resolver created earlier in the same transaction, which a
   * session-less read cannot see.
   *
   * @param {string|ObjectId} id
   * @param {import('mongoose').ClientSession|null} [session]
   */
  async findByIdInSession(id, session = null) {
    return this.model.findById(id).session(session).lean();
  }

  /**
   * Return all accounts from a list of IDs that belong to the given business.
   * Used to validate journal line account IDs for tenant isolation.
   *
   * @param {string|ObjectId} businessId
   * @param {Array<string|ObjectId>} ids
   * @param {Object} [opts]
   * @param {import('mongoose').ClientSession} [opts.session] — REQUIRED when the
   *   caller is inside a transaction that may have just created one of these
   *   accounts. A read without the session cannot see its own transaction's
   *   uncommitted writes, so the account would look like it does not exist.
   */
  async findAllByBusinessAndIds(businessId, ids, { session = null } = {}) {
    const mongoose = require('mongoose');
    const validIds = ids
      .filter(id => mongoose.isValidObjectId(id))
      .map(id => new mongoose.Types.ObjectId(id));
    if (!validIds.length) return [];
    return this.model.find(
      { businessId, _id: { $in: validIds } },
      { _id: 1 }
    ).session(session).lean();
  }

  /**
   * Update the running balance of an account by a delta.
   * @param {string} accountId
   * @param {number} delta - Positive or negative amount to add to current balance
   * @returns {Promise<Object|null>} Updated account
   */
  async updateRunningBalance(accountId, delta, session = null) {
    const validAccountId = sanitizeAndValidateId(accountId);
    if (typeof delta !== 'number' || isNaN(delta)) {
      throw new Error('Delta must be a number');
    }
    const options = { returnDocument: 'after', runValidators: false };
    if (session) options.session = session; // join an all-or-nothing transaction when given
    return this.model.findByIdAndUpdate(
      validAccountId,
      { $inc: { runningBalance: delta } },
      options
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
   * Sync missing default accounts for an existing business.
   *
   * Compares the business's current accounts against DEFAULT_ACCOUNTS using
   * accountCode as the canonical key.  Inserts any defaults that are absent
   * without touching existing accounts (additive-only, never overwrites).
   *
   * Called automatically when GET /business/accounts is served so every
   * business is silently kept up-to-date whenever DEFAULT_ACCOUNTS is expanded.
   *
   * @param {string} businessId
   * @returns {Promise<{ inserted: number }>}
   */
  async syncMissingDefaults(businessId) {
    const validBusinessId = sanitizeAndValidateId(businessId);

    // Fetch only accountCode to minimise data transfer
    const existing = await this.model
      .find({ businessId: validBusinessId }, { accountCode: 1 })
      .lean();

    const existingCodes = new Set(
      existing.map((a) => a.accountCode).filter(Boolean)
    );

    const missing = DEFAULT_ACCOUNTS.filter(
      (acc) => acc.accountCode && !existingCodes.has(acc.accountCode)
    );

    let inserted = 0;
    if (missing.length > 0) {
      const toInsert = missing.map((acc) => ({
        ...acc,
        businessId: validBusinessId,
        runningBalance: 0,
      }));

      try {
        const result = await this.model.insertMany(toInsert, { ordered: false });
        inserted = result.length;
        logger.info(
          `Synced ${inserted} missing default accounts for business ${validBusinessId}`
        );
      } catch (error) {
        // E11000 duplicate key — another request beat us to it; safe to ignore
        if (error.code === 11000 || error.name === 'BulkWriteError') {
          inserted = error.result?.nInserted ?? 0;
          logger.info(
            `Sync partial (race): ${inserted} accounts inserted for business ${validBusinessId}`
          );
        } else {
          logger.error('syncMissingDefaults failed:', error);
          throw error;
        }
      }
    }

    // Backfill isControlAccount:true onto AR/AP/tax-payable accounts created
    // before this flag existed. Additive/idempotent — only touches accounts not
    // already flagged, never touches balances or other fields.
    await this.model.updateMany(
      {
        businessId: validBusinessId,
        isControlAccount: { $ne: true },
        $or: [
          { accountCode: { $in: CONTROL_ACCOUNT_CODES } },
          { accountCode: { $regex: /^(117[0-7]|21(2[1-9]|30))$/ } }, // tax-engine dynamic range
        ],
      },
      { $set: { isControlAccount: true } }
    );

    return { inserted };
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
// controllers/business.controller.js
const businessService = require('../services/business.service');
const accountRepository = require('../repositories/account.repository');
const ApiResponse = require('../utils/ApiResponse');
const { ApiError } = require('../utils/ApiError');

/**
 * Create a new business profile (after email verification).
 * POST /api/v1/business
 */
const createBusiness = async (req, res, next) => {
  try {
    // User ID from auth middleware
    const userId = req.user.id;
    const businessData = req.body;
    const business = await businessService.createBusiness(userId, businessData, req.ip);
    ApiResponse.created(res, business, 'Business profile created successfully. Default chart of accounts generated.');
  } catch (error) {
    next(error);
  }
};

/**
 * Get the current user's business profile.
 * GET /api/v1/business
 */
const getBusiness = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const includeAccountCount = req.query.includeAccountCount === 'true';
    const business = await businessService.getBusinessByUserId(userId, includeAccountCount);
    if (!business) {
      throw new ApiError(404, 'Business profile not found');
    }
    ApiResponse.success(res, business, 'Business profile retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Update business settings.
 * PUT /api/v1/business
 */
const updateBusiness = async (req, res, next) => {
  try {
    const userId = req.user.id;
    // First get the business to obtain its ID
    const existing = await businessService.getBusinessByUserId(userId);
    if (!existing) {
      throw new ApiError(404, 'Business profile not found');
    }
    const updated = await businessService.updateBusiness(existing._id, req.body, userId, req.ip);
    ApiResponse.success(res, updated, 'Business profile updated');
  } catch (error) {
    next(error);
  }
};

/**
 * List chart of accounts for the current business.
 * GET /api/v1/business/accounts
 * Query: accountType (optional)
 *
 * ARCHITECTURE NOTE: This endpoint returns the COMPLETE Chart of Accounts
 * without pagination. Pagination was removed because:
 *  1. A CoA is a bounded, finite dataset (typically 30–300 accounts per SME).
 *  2. Transaction form dropdowns MUST show ALL accounts — a paginated API
 *     would silently truncate the account list, breaking account selection.
 *  3. The full CoA is cached on the client (TanStack Query) so repeated
 *     dropdown opens don't re-fetch.
 * If a business eventually exceeds ~500 accounts, add client-side search
 * filtering rather than server-side pagination.
 *
 * AUTO-SYNC: Every call transparently syncs any DEFAULT_ACCOUNTS entries
 * that are missing from this business (additive-only). This keeps all
 * businesses consistent when DEFAULT_ACCOUNTS is expanded over time.
 */
const getAccounts = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const business = await businessService.getBusinessByUserId(userId);
    if (!business) {
      throw new ApiError(404, 'Business profile not found');
    }

    // Await sync BEFORE fetching so this very response already includes any
    // accounts that were missing.  syncMissingDefaults is idempotent and fast
    // after the first run (returns {inserted:0} immediately on subsequent calls).
    try {
      await accountRepository.syncMissingDefaults(business._id);
    } catch (_) {
      // Sync failure is non-fatal — still return whatever accounts exist
    }

    const { accountType } = req.query;
    // findByBusiness returns ALL accounts sorted by accountType → accountName.
    // No pagination — the full CoA is required for transaction form dropdowns.
    const accounts = await accountRepository.findByBusiness(business._id, accountType || null);
    ApiResponse.success(res, accounts, 'Chart of accounts retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Explicitly sync missing default accounts for the current business.
 * POST /api/v1/business/accounts/sync
 *
 * Returns the number of accounts that were added.  Safe to call repeatedly;
 * subsequent calls after a full sync will always return { inserted: 0 }.
 */
const syncAccounts = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const business = await businessService.getBusinessByUserId(userId);
    if (!business) {
      throw new ApiError(404, 'Business profile not found');
    }
    const result = await accountRepository.syncMissingDefaults(business._id);
    ApiResponse.success(
      res,
      result,
      result.inserted > 0
        ? `Synced ${result.inserted} missing default accounts`
        : 'Chart of accounts is already up to date'
    );
  } catch (error) {
    next(error);
  }
};

/**
 * Add a custom account to the chart of accounts.
 * POST /api/v1/business/accounts
 */
const addCustomAccount = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const business = await businessService.getBusinessByUserId(userId);
    if (!business) {
      throw new ApiError(404, 'Business profile not found');
    }
    const { accountName, accountType, normalBalance } = req.body;
    // Check if account name already exists for this business
    const existing = await accountRepository.findByBusinessAndName(business._id, accountName);
    if (existing) {
      throw new ApiError(409, 'Account with this name already exists');
    }
    const newAccount = await accountRepository.create({
      businessId: business._id,
      accountName,
      accountType,
      normalBalance,
      isDefault: false,
      runningBalance: 0,
    });
    ApiResponse.created(res, newAccount, 'Custom account added successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Update an existing account (name, type, normal balance).
 * PUT /api/v1/business/accounts/:accountId
 */
const updateAccount = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { accountId } = req.params;
    const business = await businessService.getBusinessByUserId(userId);
    if (!business) {
      throw new ApiError(404, 'Business profile not found');
    }
    // Verify account belongs to this business
    const account = await accountRepository.findOneByBusinessAndId(business._id, accountId);
    if (!account) {
      throw new ApiError(404, 'Account not found in your business');
    }
    // Prevent editing default accounts? (optional – can be allowed but with warning)
    // Update allowed fields
    const updateData = {};
    if (req.body.accountName) updateData.accountName = req.body.accountName;
    if (req.body.accountType) updateData.accountType = req.body.accountType;
    if (req.body.normalBalance) updateData.normalBalance = req.body.normalBalance;
    if (Object.keys(updateData).length === 0) {
      throw new ApiError(400, 'No fields to update');
    }
    const updated = await accountRepository.update(accountId, updateData);
    ApiResponse.success(res, updated, 'Account updated successfully');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createBusiness,
  getBusiness,
  updateBusiness,
  getAccounts,
  syncAccounts,
  addCustomAccount,
  updateAccount,
};
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
 * Query: accountType (optional), page, limit (optional)
 */
const getAccounts = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const business = await businessService.getBusinessByUserId(userId);
    if (!business) {
      throw new ApiError(404, 'Business profile not found');
    }
    const { accountType, page, limit } = req.query;
    // For simplicity, we use the repository directly (or add a method in accountRepository)
    let query = { businessId: business._id };
    if (accountType) {
      query.accountType = accountType;
    }
    const pagination = { page: parseInt(page, 10) || 1, limit: parseInt(limit, 10) || 25 };
    const accounts = await accountRepository.findAll(query, pagination);
    ApiResponse.success(res, accounts, 'Chart of accounts retrieved');
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
  addCustomAccount,
  updateAccount,
};
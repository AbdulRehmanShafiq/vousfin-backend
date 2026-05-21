// controllers/transaction.controller.js
const transactionService = require('../services/transaction.service');
const installmentService = require('../services/installment.service');
const parserService = require('../services/nlParser/services/parserService');
const accountRepository = require('../repositories/account.repository');
const { mapParserToPreview } = require('../utils/nlParserPreview.helper');
const ApiResponse = require('../utils/ApiResponse');
const { ApiError } = require('../utils/ApiError');
const { parseExcelTransactions } = require('../utils/excelParser.utils');
const logger = require('../config/logger');

const resolveAccountIds = async (businessId, row) => {
  let debitAccountId = row.debitAccountId;
  let creditAccountId = row.creditAccountId;
  const debitName = row.debitAccountName || row.debitAccount;
  const creditName = row.creditAccountName || row.creditAccount;
  if (!debitAccountId && debitName) {
    const debit = await accountRepository.findByBusinessAndName(businessId, debitName);
    // findByBusinessAndName now does fuzzy matching — throw only if nothing at all found
    if (!debit) throw new ApiError(400, `Debit account not found: "${debitName}". Please check your Chart of Accounts.`);
    debitAccountId = debit._id;
  }
  if (!creditAccountId && creditName) {
    const credit = await accountRepository.findByBusinessAndName(businessId, creditName);
    if (!credit) throw new ApiError(400, `Credit account not found: "${creditName}". Please check your Chart of Accounts.`);
    creditAccountId = credit._id;
  }
  return { debitAccountId, creditAccountId };
};

/**
 * Create a transaction from structured form.
 */
const createFormTransaction = async (req, res, next) => {
  try {
    const transactionData = {
      ...req.body,
      businessId: req.user.businessId,
      inputMethod: 'form',
    };
    const transaction = await transactionService.createTransaction(
      transactionData,
      req.user.id,
      req.ip
    );
    ApiResponse.created(res, transaction, 'Transaction recorded successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Record a partial or full payment against a parent transaction.
 * POST /api/v1/transactions/payment
 */
const recordPayment = async (req, res, next) => {
  try {
    const { parentTransactionId, ...paymentData } = req.body;
    if (!parentTransactionId) throw new ApiError(400, 'parentTransactionId is required');

    const paymentTx = await transactionService.recordPartialPayment(
      parentTransactionId,
      req.user.businessId,
      paymentData,
      req.user.id,
      req.ip
    );
    ApiResponse.created(res, paymentTx, 'Payment recorded successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Get outstanding balances (Receivables or Payables).
 * GET /api/v1/transactions/outstanding
 */
const getOutstandingBalances = async (req, res, next) => {
  try {
    const { type } = req.query; // 'receivable' or 'payable'
    if (!type) throw new ApiError(400, 'type query parameter is required (receivable or payable)');

    const outstanding = await transactionService.getOutstandingBalances(req.user.businessId, type);
    ApiResponse.success(res, outstanding, 'Outstanding balances retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Get settlement history for a parent transaction.
 * GET /api/v1/transactions/:id/settlements
 */
const getSettlementHistory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const history = await transactionService.getSettlementHistory(id, req.user.businessId);
    ApiResponse.success(res, history, 'Settlement history retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Create an installment transaction (creates entry + plan).
 * POST /api/v1/transactions/installment
 */
const createInstallmentTransaction = async (req, res, next) => {
  try {
    const {
      transactionDate, description, amount, debitAccountId, creditAccountId,
      customerId, vendorId,
      downPayment, installmentCount, installmentFrequency
    } = req.body;

    const transactionData = {
      businessId: req.user.businessId,
      transactionDate,
      description,
      amount,
      debitAccountId,
      creditAccountId,
      customerId,
      vendorId,
      inputMethod: 'form',
    };

    const installmentConfig = {
      downPayment: downPayment || 0,
      installmentCount,
      installmentFrequency
    };

    const result = await installmentService.createInstallmentPlan(
      transactionData,
      installmentConfig,
      req.user.id,
      req.ip
    );

    ApiResponse.created(res, result, 'Installment transaction created successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Record a payment against an installment plan.
 * POST /api/v1/transactions/installment/:planId/pay
 */
const recordInstallmentPayment = async (req, res, next) => {
  try {
    const { planId } = req.params;
    const paymentData = req.body;
    
    const result = await installmentService.recordInstallmentPayment(
      planId,
      req.user.businessId,
      paymentData,
      req.user.id,
      req.ip
    );

    ApiResponse.success(res, result, 'Installment payment recorded successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Process natural language input and return a preview.
 */
const processNaturalLanguage = async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text || text.trim().length < 5) {
      throw new ApiError(400, 'Please provide a longer transaction description');
    }
    const parsed = await parserService.parseTransaction(text);
    const preview = mapParserToPreview(parsed, text);

    if (req.user.businessId && (preview.debitAccount || preview.creditAccount)) {
      // Gracefully resolve — fuzzy match, don't throw if not found
      try {
        if (preview.debitAccount) {
          const debit = await accountRepository.findByBusinessAndName(req.user.businessId, preview.debitAccount);
          preview.debitAccountId = debit?._id || null;
          if (debit) preview.debitAccount = debit.accountName; // normalize to actual name
        }
        if (preview.creditAccount) {
          const credit = await accountRepository.findByBusinessAndName(req.user.businessId, preview.creditAccount);
          preview.creditAccountId = credit?._id || null;
          if (credit) preview.creditAccount = credit.accountName;
        }
      } catch (resolveErr) {
        logger.warn('NL account resolution partial failure (non-fatal):', resolveErr.message);
        // Continue — user will pick accounts manually in preview step
      }
    }

    ApiResponse.success(res, preview, 'Preview generated. Confirm to save.');
  } catch (error) {
    next(error);
  }
};

/**
 * Confirm and save a natural language transaction (after preview).
 */
const confirmNaturalLanguage = async (req, res, next) => {
  try {
    const { transactionDate, description, transactionType, amount } = req.body;
    const { debitAccountId, creditAccountId } = await resolveAccountIds(req.user.businessId, req.body);
    if (!debitAccountId || !creditAccountId) {
      throw new ApiError(400, 'Debit and credit accounts are required. Resolve account names or pass account IDs.');
    }
    const transactionData = {
      transactionDate,
      description,
      transactionType,
      amount,
      debitAccountId,
      creditAccountId,
      businessId: req.user.businessId,
      inputMethod: 'nlp',
    };
    const transaction = await transactionService.createTransaction(
      transactionData,
      req.user.id,
      req.ip
    );
    ApiResponse.created(res, transaction, 'Transaction recorded from natural language');
  } catch (error) {
    next(error);
  }
};

/**
 * Upload Excel file, parse and validate rows, return preview.
 */
const uploadExcelPreview = async (req, res, next) => {
  try {
    if (!req.file) {
      throw new ApiError(400, 'Excel file is required');
    }
    const buffer = req.file.buffer;
    const businessId = req.user.businessId;
    const { validRows, errors } = await parseExcelTransactions(buffer, businessId);
    const resolvedRows = [];
    for (const row of validRows) {
      try {
        const { debitAccountId, creditAccountId } = await resolveAccountIds(businessId, row);
        resolvedRows.push({
          ...row,
          debitAccountId,
          creditAccountId,
        });
      } catch (resolveErr) {
        errors.push({
          row: row.originalRow,
          field: 'account',
          message: resolveErr.message,
        });
      }
    }
    ApiResponse.success(res, {
      validCount: resolvedRows.length,
      invalidCount: errors.length,
      validRows: resolvedRows,
      errors,
    }, 'Excel preview generated');
  } catch (error) {
    next(error);
  }
};

/**
 * Confirm Excel import and bulk save transactions.
 */
const confirmExcelImport = async (req, res, next) => {
  try {
    const { rows } = req.body; // rows should be the valid rows from preview, possibly with resolved account IDs
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      throw new ApiError(400, 'No valid rows to import');
    }
    const transactionsToCreate = [];
    for (const row of rows) {
      const { debitAccountId, creditAccountId } = await resolveAccountIds(req.user.businessId, row);
      transactionsToCreate.push({
        transactionDate: row.transactionDate,
        description: row.description,
        transactionType: row.transactionType,
        amount: row.amount,
        debitAccountId,
        creditAccountId,
        businessId: req.user.businessId,
        inputMethod: 'excel',
      });
    }
    const results = await transactionService.createBulkTransactions(
      transactionsToCreate,
      req.user.id,
      req.ip
    );
    ApiResponse.success(res, results, `${results.successful} transactions imported successfully`);
  } catch (error) {
    next(error);
  }
};

/**
 * Get list of transactions with filtering and pagination.
 */
const getTransactions = async (req, res, next) => {
  try {
    const filters = {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      transactionType: req.query.transactionType,
      minAmount: req.query.minAmount,
      maxAmount: req.query.maxAmount,
      accountId: req.query.accountId,
      customerId: req.query.customerId,
      vendorId: req.query.vendorId,
      status: req.query.status,
      paymentStatus: req.query.paymentStatus,
      hasOutstandingBalance: req.query.hasOutstandingBalance,
      search: req.query.search,
    };
    const pagination = {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 25,
      sortBy: req.query.sortBy || 'transactionDate',
      sortOrder: req.query.sortOrder === 'asc' ? 1 : -1,
    };
    const result = await transactionService.getTransactionHistory(
      req.user.businessId,
      filters,
      pagination
    );
    ApiResponse.success(res, result, 'Transactions retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Get a single transaction by ID (with details and audit trail).
 */
const getTransactionById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const transaction = await transactionService.getTransactionById(id, req.user.businessId);
    ApiResponse.success(res, transaction, 'Transaction details retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Update an existing transaction.
 */
const updateTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    const updated = await transactionService.editTransaction(
      id,
      req.user.businessId,
      updateData,
      req.user.id,
      req.ip
    );
    ApiResponse.success(res, updated, 'Transaction updated successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Delete (reverse) a transaction.
 */
const deleteTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const reversal = await transactionService.deleteTransaction(
      id,
      req.user.businessId,
      req.user.id,
      req.ip
    );
    ApiResponse.success(res, reversal, 'Transaction reversed successfully');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createFormTransaction,
  recordPayment,
  getOutstandingBalances,
  getSettlementHistory,
  createInstallmentTransaction,
  recordInstallmentPayment,
  processNaturalLanguage,
  confirmNaturalLanguage,
  uploadExcelPreview,
  confirmExcelImport,
  getTransactions,
  getTransactionById,
  updateTransaction,
  deleteTransaction,
};
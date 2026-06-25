// controllers/bankReconciliation.controller.js
const reconciliationService = require('../services/bankReconciliation.service');
const ApiResponse = require('../utils/ApiResponse');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');

const ALLOWED_EXT = new Set(['csv', 'xlsx', 'xls']);

/**
 * POST /api/v1/bank-reconciliation/parse
 * Parse an uploaded statement file → preview lines (no save).
 */
const parse = async (req, res, next) => {
  try {
    if (!req.file) throw new ApiError(400, 'Statement file is required (form-data field "file").');
    const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
    if (!ALLOWED_EXT.has(ext)) throw new ApiError(400, `Unsupported file ".${ext}". Upload .csv, .xlsx, or .xls.`);

    const { lines, columns, warnings } = reconciliationService.parse(req.file.buffer, req.file.originalname);
    logger.info(`[reconcile] parsed ${lines.length} lines from ${req.file.originalname}`);
    ApiResponse.success(res, {
      lines, columns, warnings,
      fileName: req.file.originalname,
      count: lines.length,
    }, `${lines.length} lines read from statement`);
  } catch (error) { next(error); }
};

/**
 * POST /api/v1/bank-reconciliation/import
 * Body: { bankAccountId, name?, fileName?, lines[], openingBalance?, closingBalance?, periodStart?, periodEnd? }
 */
const importStatement = async (req, res, next) => {
  try {
    const statement = await reconciliationService.importStatement(req.user.businessId, req.body, req.user);
    ApiResponse.created(res, statement, 'Statement imported and auto-matched');
  } catch (error) { next(error); }
};

/** GET /api/v1/bank-reconciliation?bankAccountId= */
const list = async (req, res, next) => {
  try {
    const sessions = await reconciliationService.list(req.user.businessId, { bankAccountId: req.query.bankAccountId });
    ApiResponse.success(res, sessions, 'Reconciliation sessions retrieved');
  } catch (error) { next(error); }
};

/** GET /api/v1/bank-reconciliation/:id */
const getStatement = async (req, res, next) => {
  try {
    const statement = await reconciliationService.getStatement(req.params.id, req.user.businessId);
    ApiResponse.success(res, statement, 'Statement retrieved');
  } catch (error) { next(error); }
};

/** POST /api/v1/bank-reconciliation/:id/lines/:lineRef/match  Body: { journalEntryId } */
const match = async (req, res, next) => {
  try {
    const statement = await reconciliationService.confirmMatch(
      req.params.id, req.params.lineRef, req.body.journalEntryId, req.user.businessId, req.user
    );
    ApiResponse.success(res, statement, 'Line matched');
  } catch (error) { next(error); }
};

/** POST /api/v1/bank-reconciliation/:id/lines/:lineRef/unmatch */
const unmatch = async (req, res, next) => {
  try {
    const statement = await reconciliationService.unmatch(req.params.id, req.params.lineRef, req.user.businessId);
    ApiResponse.success(res, statement, 'Match removed');
  } catch (error) { next(error); }
};

/** POST /api/v1/bank-reconciliation/:id/lines/:lineRef/clear  Body: { note? } */
const clear = async (req, res, next) => {
  try {
    const statement = await reconciliationService.markCleared(
      req.params.id, req.params.lineRef, req.user.businessId, req.user, req.body?.note
    );
    ApiResponse.success(res, statement, 'Line marked cleared');
  } catch (error) { next(error); }
};

/**
 * POST /api/v1/bank-reconciliation/:id/lines/:lineRef/create
 * Body: { categoryAccountId, description?, vendorName?, customerName? }
 */
const createFromLine = async (req, res, next) => {
  try {
    const statement = await reconciliationService.createFromLine(
      req.params.id, req.params.lineRef, req.user.businessId, req.body, req.user, req.ip
    );
    ApiResponse.created(res, statement, 'Entry posted and matched');
  } catch (error) { next(error); }
};

/** POST /api/v1/bank-reconciliation/:id/finish */
const finish = async (req, res, next) => {
  try {
    const statement = await reconciliationService.finish(req.params.id, req.user.businessId, req.user);
    ApiResponse.success(res, statement, 'Reconciliation completed');
  } catch (error) { next(error); }
};

/** DELETE /api/v1/bank-reconciliation/:id */
const remove = async (req, res, next) => {
  try {
    const result = await reconciliationService.remove(req.params.id, req.user.businessId);
    ApiResponse.success(res, result, 'Reconciliation session deleted');
  } catch (error) { next(error); }
};

/** POST /api/v1/bank-reconciliation/:id/auto-match */
const autoMatch = async (req, res, next) => {
  try {
    const result = await reconciliationService.autoMatch(req.user.businessId, req.params.id, req.user);
    ApiResponse.success(res, result, 'Auto-match completed');
  } catch (error) { next(error); }
};

/** POST /api/v1/bank-reconciliation/:id/accept-batch  Body: { lineRefs: [] } */
const acceptBatch = async (req, res, next) => {
  try {
    const result = await reconciliationService.acceptBatch(req.user.businessId, req.params.id, req.body.lineRefs, req.user);
    ApiResponse.success(res, result, 'Batch acceptance completed');
  } catch (error) { next(error); }
};

module.exports = {
  parse, importStatement, list, getStatement,
  match, unmatch, clear, createFromLine, finish, remove,
  autoMatch, acceptBatch,
};

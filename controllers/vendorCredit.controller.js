// controllers/vendorCredit.controller.js
//
// Phase 3.1 — HTTP layer over services/vendorCredit.service.js.
//
const vcService = require('../services/vendorCredit.service');
const ApiResponse = require('../utils/ApiResponse');

function actor(req) {
  return {
    _id:      req.user.id,
    fullName: req.user.fullName,
    email:    req.user.email,
    role:     req.user.role,
  };
}

// ── CRUD ───────────────────────────────────────────────────────────────────────

exports.create = async (req, res, next) => {
  try {
    const vc = await vcService.create(
      { ...req.body, businessId: req.user.businessId },
      actor(req),
      req.ip
    );
    ApiResponse.created(res, vc, 'Vendor credit created');
  } catch (err) { next(err); }
};

exports.list = async (req, res, next) => {
  try {
    const filters = {
      state:     req.query.state,
      vendorId:  req.query.vendorId,
      reason:    req.query.reason,
      openOnly:  req.query.openOnly === 'true',
      search:    req.query.search,
      startDate: req.query.startDate,
      endDate:   req.query.endDate,
    };
    const pagination = {
      page:  parseInt(req.query.page,  10) || 1,
      limit: parseInt(req.query.limit, 10) || 25,
    };
    const result = await vcService.list(req.user.businessId, filters, pagination);
    ApiResponse.success(res, result, 'Vendor credits retrieved');
  } catch (err) { next(err); }
};

exports.getById = async (req, res, next) => {
  try {
    const vc = await vcService.getById(req.params.id, req.user.businessId);
    ApiResponse.success(res, vc, 'Vendor credit retrieved');
  } catch (err) { next(err); }
};

exports.softDelete = async (req, res, next) => {
  try {
    const vc = await vcService.softDelete(req.params.id, actor(req), req.ip);
    ApiResponse.success(res, vc, 'Vendor credit archived');
  } catch (err) { next(err); }
};

// ── Workflow ──────────────────────────────────────────────────────────────────

exports.applyToBill = async (req, res, next) => {
  try {
    const { billId, amount, notes } = req.body || {};
    const vc = await vcService.applyToBill(
      req.params.id,
      billId,
      Number(amount),
      actor(req),
      notes,
      req.ip
    );
    ApiResponse.success(res, vc, 'Vendor credit applied to bill');
  } catch (err) { next(err); }
};

exports.cancel = async (req, res, next) => {
  try {
    const vc = await vcService.cancel(req.params.id, actor(req), req.body?.reason, req.ip);
    ApiResponse.success(res, vc, 'Vendor credit cancelled');
  } catch (err) { next(err); }
};

// ── Helper used by Bill editor ────────────────────────────────────────────────

exports.getAvailableCredits = async (req, res, next) => {
  try {
    const { vendorId } = req.query;
    if (!vendorId) {
      return ApiResponse.success(res, [], 'No vendorId provided');
    }
    const credits = await vcService.getAvailableCredits(req.user.businessId, vendorId);
    ApiResponse.success(res, credits, 'Available vendor credits');
  } catch (err) { next(err); }
};

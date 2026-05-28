// controllers/purchaseOrder.controller.js
//
// Phase 3.1 — HTTP layer over services/purchaseOrder.service.js.
//
const poService = require('../services/purchaseOrder.service');
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

exports.createDraft = async (req, res, next) => {
  try {
    const po = await poService.createDraft(
      { ...req.body, businessId: req.user.businessId },
      actor(req),
      req.ip
    );
    ApiResponse.created(res, po, 'Purchase order draft created');
  } catch (err) { next(err); }
};

exports.updateDraft = async (req, res, next) => {
  try {
    const po = await poService.updateDraft(
      req.params.id,
      { ...req.body, businessId: req.user.businessId },
      actor(req),
      req.ip
    );
    ApiResponse.success(res, po, 'Purchase order draft updated');
  } catch (err) { next(err); }
};

exports.list = async (req, res, next) => {
  try {
    const filters = {
      state:          req.query.state,
      vendorId:       req.query.vendorId,
      approvalStatus: req.query.approvalStatus,
      search:         req.query.search,
      startDate:      req.query.startDate,
      endDate:        req.query.endDate,
    };
    const pagination = {
      page:  parseInt(req.query.page,  10) || 1,
      limit: parseInt(req.query.limit, 10) || 25,
    };
    const result = await poService.list(req.user.businessId, filters, pagination);
    ApiResponse.success(res, result, 'Purchase orders retrieved');
  } catch (err) { next(err); }
};

exports.getById = async (req, res, next) => {
  try {
    const po = await poService.getById(req.params.id, req.user.businessId);
    ApiResponse.success(res, po, 'Purchase order retrieved');
  } catch (err) { next(err); }
};

exports.getTimeline = async (req, res, next) => {
  try {
    const result = await poService.getTimeline(req.params.id, req.user.businessId);
    ApiResponse.success(res, result, 'Purchase order timeline retrieved');
  } catch (err) { next(err); }
};

exports.softDelete = async (req, res, next) => {
  try {
    const po = await poService.softDelete(req.params.id, actor(req), req.ip);
    ApiResponse.success(res, po, 'Purchase order archived');
  } catch (err) { next(err); }
};

// ── Approval workflow ─────────────────────────────────────────────────────────

exports.submitForApproval = async (req, res, next) => {
  try {
    const po = await poService.submitForApproval(req.params.id, actor(req), req.ip);
    ApiResponse.success(res, po, 'Purchase order submitted for approval');
  } catch (err) { next(err); }
};

exports.approve = async (req, res, next) => {
  try {
    const po = await poService.approve(req.params.id, actor(req), req.body?.note, req.ip);
    ApiResponse.success(res, po, 'Purchase order approved');
  } catch (err) { next(err); }
};

exports.reject = async (req, res, next) => {
  try {
    const po = await poService.reject(req.params.id, actor(req), req.body?.note, req.ip);
    ApiResponse.success(res, po, 'Purchase order rejected');
  } catch (err) { next(err); }
};

// ── Lifecycle ─────────────────────────────────────────────────────────────────

exports.cancel = async (req, res, next) => {
  try {
    const po = await poService.cancel(req.params.id, actor(req), req.body?.reason, req.ip);
    ApiResponse.success(res, po, 'Purchase order cancelled');
  } catch (err) { next(err); }
};

exports.close = async (req, res, next) => {
  try {
    const po = await poService.close(req.params.id, actor(req), req.body?.reason, req.ip);
    ApiResponse.success(res, po, 'Purchase order closed');
  } catch (err) { next(err); }
};

// ── 3-Way Match ───────────────────────────────────────────────────────────────

exports.runThreeWayMatch = async (req, res, next) => {
  try {
    const { grnTotalValue, billAmount } = req.body || {};
    const result = await poService.runThreeWayMatch(
      req.params.id,
      Number(grnTotalValue) || 0,
      Number(billAmount) || 0
    );
    ApiResponse.success(res, result, '3-Way match result');
  } catch (err) { next(err); }
};

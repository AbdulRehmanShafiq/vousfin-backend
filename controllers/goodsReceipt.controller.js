// controllers/goodsReceipt.controller.js
//
// Phase 3.1 — HTTP layer over services/goodsReceipt.service.js.
//
const grnService = require('../services/goodsReceipt.service');
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
    const grn = await grnService.createDraft(
      { ...req.body, businessId: req.user.businessId },
      actor(req),
      req.ip
    );
    ApiResponse.created(res, grn, 'Goods receipt draft created');
  } catch (err) { next(err); }
};

exports.list = async (req, res, next) => {
  try {
    const filters = {
      state:           req.query.state,
      vendorId:        req.query.vendorId,
      purchaseOrderId: req.query.purchaseOrderId,
      hasDiscrepancies:req.query.hasDiscrepancies === 'true'  ? true
                      : req.query.hasDiscrepancies === 'false' ? false
                      : undefined,
      search:          req.query.search,
      startDate:       req.query.startDate,
      endDate:         req.query.endDate,
    };
    const pagination = {
      page:  parseInt(req.query.page,  10) || 1,
      limit: parseInt(req.query.limit, 10) || 25,
    };
    const result = await grnService.list(req.user.businessId, filters, pagination);
    ApiResponse.success(res, result, 'Goods receipts retrieved');
  } catch (err) { next(err); }
};

exports.getById = async (req, res, next) => {
  try {
    const grn = await grnService.getById(req.params.id, req.user.businessId);
    ApiResponse.success(res, grn, 'Goods receipt retrieved');
  } catch (err) { next(err); }
};

exports.softDelete = async (req, res, next) => {
  try {
    const grn = await grnService.softDelete(req.params.id, actor(req), req.ip);
    ApiResponse.success(res, grn, 'Goods receipt archived');
  } catch (err) { next(err); }
};

// ── Workflow ──────────────────────────────────────────────────────────────────

exports.confirm = async (req, res, next) => {
  try {
    const grn = await grnService.confirm(req.params.id, actor(req), req.ip);
    ApiResponse.success(res, grn, 'Goods receipt confirmed');
  } catch (err) { next(err); }
};

exports.reconcile = async (req, res, next) => {
  try {
    const grn = await grnService.reconcile(
      req.params.id,
      req.body?.resolutions || [],
      actor(req),
      req.ip
    );
    ApiResponse.success(res, grn, 'Discrepancies updated');
  } catch (err) { next(err); }
};

exports.cancel = async (req, res, next) => {
  try {
    const grn = await grnService.cancel(req.params.id, actor(req), req.body?.reason, req.ip);
    ApiResponse.success(res, grn, 'Goods receipt cancelled');
  } catch (err) { next(err); }
};

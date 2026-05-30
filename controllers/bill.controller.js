// controllers/bill.controller.js
//
// Phase 1 — HTTP layer over services/bill.service.js.
//
const billService = require('../services/bill.service');
const ApiResponse = require('../utils/ApiResponse');

function actor(req) {
  return {
    _id:      req.user.id,
    fullName: req.user.fullName,
    email:    req.user.email,
    role:     req.user.role,
  };
}

exports.createDraft = async (req, res, next) => {
  try {
    const bill = await billService.createDraft(
      { ...req.body, businessId: req.user.businessId },
      actor(req),
      req.ip
    );
    ApiResponse.created(res, bill, 'Bill draft created');
  } catch (err) { next(err); }
};

// Phase 2: Update draft
exports.updateDraft = async (req, res, next) => {
  try {
    const bill = await billService.updateDraft(
      req.params.id,
      { ...req.body, businessId: req.user.businessId },
      actor(req),
      req.ip
    );
    ApiResponse.success(res, bill, 'Bill draft updated');
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
      page:  parseInt(req.query.page, 10)  || 1,
      limit: parseInt(req.query.limit, 10) || 25,
    };
    const result = await billService.list(req.user.businessId, filters, pagination);
    ApiResponse.success(res, result, 'Bills retrieved');
  } catch (err) { next(err); }
};

exports.getById = async (req, res, next) => {
  try {
    const bill = await billService.getById(req.params.id, req.user.businessId);
    ApiResponse.success(res, bill, 'Bill retrieved');
  } catch (err) { next(err); }
};

exports.submitForApproval = async (req, res, next) => {
  try {
    const bill = await billService.submitForApproval(req.params.id, actor(req), req.ip, { multiLevel: req.body?.multiLevel === true });
    ApiResponse.success(res, bill, 'Bill submitted for approval');
  } catch (err) { next(err); }
};

exports.approve = async (req, res, next) => {
  try {
    const bill = await billService.approve(req.params.id, actor(req), req.body?.note, req.ip);
    ApiResponse.success(res, bill, 'Bill approved');
  } catch (err) { next(err); }
};

exports.reject = async (req, res, next) => {
  try {
    const bill = await billService.reject(req.params.id, actor(req), req.body?.note, req.ip);
    ApiResponse.success(res, bill, 'Bill rejected');
  } catch (err) { next(err); }
};

exports.schedule = async (req, res, next) => {
  try {
    const bill = await billService.schedule(
      req.params.id,
      actor(req),
      req.body?.payDate || null,
      req.ip
    );
    ApiResponse.success(res, bill, 'Bill scheduled');
  } catch (err) { next(err); }
};

exports.cancel = async (req, res, next) => {
  try {
    const bill = await billService.cancel(req.params.id, actor(req), req.body?.reason, req.ip);
    ApiResponse.success(res, bill, 'Bill cancelled');
  } catch (err) { next(err); }
};

// M5 — GL-correct void + vendor credit memo
exports.void = async (req, res, next) => {
  try {
    const bill = await billService.void(req.params.id, req.body?.reason, actor(req), req.ip);
    ApiResponse.success(res, bill, 'Bill voided');
  } catch (err) { next(err); }
};

exports.applyCreditMemo = async (req, res, next) => {
  try {
    const bill = await billService.applyCreditMemo(req.params.id, req.body?.amount, req.body?.reason, actor(req), req.ip);
    ApiResponse.success(res, bill, 'Credit memo applied');
  } catch (err) { next(err); }
};

// M6 — multi-level approval actions
exports.reassignApproval = async (req, res, next) => {
  try {
    const bill = await billService.actOnApproval(req.params.id, 'reassign', actor(req), { note: req.body?.note, level: req.body?.level }, req.ip);
    ApiResponse.success(res, bill, 'Approval step reassigned');
  } catch (err) { next(err); }
};

exports.escalateApproval = async (req, res, next) => {
  try {
    const bill = await billService.actOnApproval(req.params.id, 'escalate', actor(req), { note: req.body?.note }, req.ip);
    ApiResponse.success(res, bill, 'Approval step escalated');
  } catch (err) { next(err); }
};

exports.softDelete = async (req, res, next) => {
  try {
    const bill = await billService.softDelete(req.params.id, actor(req), req.ip);
    ApiResponse.success(res, bill, 'Bill archived');
  } catch (err) { next(err); }
};

exports.getTimeline = async (req, res, next) => {
  try {
    const result = await billService.getTimeline(req.params.id, req.user.businessId);
    ApiResponse.success(res, result, 'Bill timeline retrieved');
  } catch (err) { next(err); }
};

exports.transitionState = async (req, res, next) => {
  try {
    const { toState, reason } = req.body || {};
    const bill = await billService.transitionState(
      req.params.id,
      toState,
      actor(req),
      { reason, ipAddress: req.ip }
    );
    ApiResponse.success(res, bill, `Bill transitioned to ${toState}`);
  } catch (err) { next(err); }
};

// Phase 3.2 — run 3-way match on demand
exports.runMatch = async (req, res, next) => {
  try {
    const toleranceCfg = req.body?.toleranceCfg || {};
    const result = await billService.runMatch(
      req.params.id,
      req.user.businessId,
      toleranceCfg
    );
    ApiResponse.success(res, result, `3-way match result: ${result.status}`);
  } catch (err) { next(err); }
};

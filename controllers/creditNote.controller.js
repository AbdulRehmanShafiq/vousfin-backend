// controllers/creditNote.controller.js
//
// Phase 2 — Thin HTTP layer for credit note / debit note operations.
//
const creditNoteService = require('../services/creditNote.service');
const ApiResponse = require('../utils/ApiResponse');

function actor(req) {
  return {
    _id:      req.user.id,
    fullName: req.user.fullName,
    email:    req.user.email,
    role:     req.user.role,
  };
}

exports.create = async (req, res, next) => {
  try {
    const cn = await creditNoteService.create(
      { ...req.body, businessId: req.user.businessId },
      actor(req),
      req.ip
    );
    ApiResponse.created(res, cn, 'Credit note created');
  } catch (err) { next(err); }
};

exports.list = async (req, res, next) => {
  try {
    const filters = {
      state:     req.query.state,
      invoiceId: req.query.invoiceId,
      noteType:  req.query.noteType,
    };
    const pagination = {
      page:  parseInt(req.query.page, 10)  || 1,
      limit: parseInt(req.query.limit, 10) || 25,
    };
    const result = await creditNoteService.list(req.user.businessId, filters, pagination);
    ApiResponse.success(res, result, 'Credit notes retrieved');
  } catch (err) { next(err); }
};

exports.getById = async (req, res, next) => {
  try {
    const cn = await creditNoteService.getById(req.params.id, req.user.businessId);
    ApiResponse.success(res, cn, 'Credit note retrieved');
  } catch (err) { next(err); }
};

exports.listByInvoice = async (req, res, next) => {
  try {
    const data = await creditNoteService.listByInvoice(req.params.invoiceId, req.user.businessId);
    ApiResponse.success(res, data, 'Credit notes for invoice retrieved');
  } catch (err) { next(err); }
};

exports.approve = async (req, res, next) => {
  try {
    const cn = await creditNoteService.approve(req.params.id, actor(req), req.ip);
    ApiResponse.success(res, cn, 'Credit note approved');
  } catch (err) { next(err); }
};

exports.apply = async (req, res, next) => {
  try {
    const cn = await creditNoteService.apply(req.params.id, actor(req), req.ip);
    ApiResponse.success(res, cn, 'Credit note applied');
  } catch (err) { next(err); }
};

exports.cancel = async (req, res, next) => {
  try {
    const cn = await creditNoteService.cancel(req.params.id, actor(req), req.body?.reason, req.ip);
    ApiResponse.success(res, cn, 'Credit note cancelled');
  } catch (err) { next(err); }
};

exports.softDelete = async (req, res, next) => {
  try {
    const cn = await creditNoteService.softDelete(req.params.id, actor(req), req.ip);
    ApiResponse.success(res, cn, 'Credit note archived');
  } catch (err) { next(err); }
};

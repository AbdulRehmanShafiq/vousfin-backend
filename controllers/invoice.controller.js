// controllers/invoice.controller.js
//
// Phase 1 — Thin HTTP layer over services/invoice.service.js.
// All business logic lives in the service; this file maps req → service args
// and shapes responses via ApiResponse helpers.
//
const invoiceService = require('../services/invoice.service');
const invoicePdfService = require('../services/invoicePdf.service');
const ApiResponse = require('../utils/ApiResponse');

/** Build the canonical user payload services expect from req.user (auth attaches id, not _id). */
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
    const invoice = await invoiceService.createDraft(
      { ...req.body, businessId: req.user.businessId },
      actor(req),
      req.ip
    );
    ApiResponse.created(res, invoice, 'Invoice draft created');
  } catch (err) { next(err); }
};

// Phase 2: Update draft
exports.updateDraft = async (req, res, next) => {
  try {
    const invoice = await invoiceService.updateDraft(
      req.params.id,
      { ...req.body, businessId: req.user.businessId },
      actor(req),
      req.ip
    );
    ApiResponse.success(res, invoice, 'Invoice draft updated');
  } catch (err) { next(err); }
};

// Phase 2: Download PDF
exports.downloadPdf = async (req, res, next) => {
  try {
    const invoice = await invoiceService.getById(req.params.id, req.user.businessId);
    // Pass business details for the PDF header
    const Business = require('../models/Business.model');
    const biz = await Business.findById(req.user.businessId).lean();
    await invoicePdfService.streamPdf(
      invoice.toObject ? invoice.toObject() : invoice,
      {
        businessName: biz?.businessName || '',
        address:      biz?.address || '',
        phone:        biz?.phone || '',
        email:        biz?.email || '',
        taxId:        biz?.taxId || biz?.ntn || '',
      },
      res
    );
  } catch (err) { next(err); }
};

exports.list = async (req, res, next) => {
  try {
    const filters = {
      state:          req.query.state,
      customerId:     req.query.customerId,
      approvalStatus: req.query.approvalStatus,
      search:         req.query.search,
      startDate:      req.query.startDate,
      endDate:        req.query.endDate,
    };
    const pagination = {
      page:  parseInt(req.query.page, 10)  || 1,
      limit: parseInt(req.query.limit, 10) || 25,
    };
    const result = await invoiceService.list(req.user.businessId, filters, pagination);
    ApiResponse.success(res, result, 'Invoices retrieved');
  } catch (err) { next(err); }
};

exports.getById = async (req, res, next) => {
  try {
    const invoice = await invoiceService.getById(req.params.id, req.user.businessId);
    ApiResponse.success(res, invoice, 'Invoice retrieved');
  } catch (err) { next(err); }
};

exports.submitForApproval = async (req, res, next) => {
  try {
    const invoice = await invoiceService.submitForApproval(req.params.id, actor(req), req.ip, { multiLevel: req.body?.multiLevel === true });
    ApiResponse.success(res, invoice, 'Invoice submitted for approval');
  } catch (err) { next(err); }
};

exports.approve = async (req, res, next) => {
  try {
    const invoice = await invoiceService.approve(req.params.id, actor(req), req.body?.note, req.ip);
    ApiResponse.success(res, invoice, 'Invoice approved');
  } catch (err) { next(err); }
};

exports.reject = async (req, res, next) => {
  try {
    const invoice = await invoiceService.reject(req.params.id, actor(req), req.body?.note, req.ip);
    ApiResponse.success(res, invoice, 'Invoice rejected');
  } catch (err) { next(err); }
};

exports.send = async (req, res, next) => {
  try {
    const invoice = await invoiceService.send(req.params.id, actor(req), req.ip);
    ApiResponse.success(res, invoice, 'Invoice sent');
  } catch (err) { next(err); }
};

exports.cancel = async (req, res, next) => {
  try {
    const invoice = await invoiceService.cancel(req.params.id, actor(req), req.body?.reason, req.ip);
    ApiResponse.success(res, invoice, 'Invoice cancelled');
  } catch (err) { next(err); }
};

// M5 — GL-correct void + customer credit memo
exports.void = async (req, res, next) => {
  try {
    const invoice = await invoiceService.void(req.params.id, req.body?.reason, actor(req), req.ip);
    ApiResponse.success(res, invoice, 'Invoice voided');
  } catch (err) { next(err); }
};

exports.applyCreditMemo = async (req, res, next) => {
  try {
    const invoice = await invoiceService.applyCreditMemo(req.params.id, req.body?.amount, req.body?.reason, actor(req), req.ip);
    ApiResponse.success(res, invoice, 'Credit memo applied');
  } catch (err) { next(err); }
};

// M6 — multi-level approval actions
exports.reassignApproval = async (req, res, next) => {
  try {
    const invoice = await invoiceService.actOnApproval(req.params.id, 'reassign', actor(req), { note: req.body?.note, level: req.body?.level }, req.ip);
    ApiResponse.success(res, invoice, 'Approval step reassigned');
  } catch (err) { next(err); }
};

exports.escalateApproval = async (req, res, next) => {
  try {
    const invoice = await invoiceService.actOnApproval(req.params.id, 'escalate', actor(req), { note: req.body?.note }, req.ip);
    ApiResponse.success(res, invoice, 'Approval step escalated');
  } catch (err) { next(err); }
};

exports.dispute = async (req, res, next) => {
  try {
    const invoice = await invoiceService.dispute(req.params.id, actor(req), req.body?.reason, req.ip);
    ApiResponse.success(res, invoice, 'Invoice disputed');
  } catch (err) { next(err); }
};

exports.writeOff = async (req, res, next) => {
  try {
    const invoice = await invoiceService.writeOff(req.params.id, actor(req), req.body?.reason, req.ip);
    ApiResponse.success(res, invoice, 'Invoice written off');
  } catch (err) { next(err); }
};

exports.softDelete = async (req, res, next) => {
  try {
    const invoice = await invoiceService.softDelete(req.params.id, actor(req), req.ip);
    ApiResponse.success(res, invoice, 'Invoice archived');
  } catch (err) { next(err); }
};

exports.getTimeline = async (req, res, next) => {
  try {
    const result = await invoiceService.getTimeline(req.params.id, req.user.businessId);
    ApiResponse.success(res, result, 'Invoice timeline retrieved');
  } catch (err) { next(err); }
};

exports.transitionState = async (req, res, next) => {
  try {
    const { toState, reason } = req.body || {};
    const invoice = await invoiceService.transitionState(
      req.params.id,
      toState,
      actor(req),
      { reason, ipAddress: req.ip }
    );
    ApiResponse.success(res, invoice, `Invoice transitioned to ${toState}`);
  } catch (err) { next(err); }
};

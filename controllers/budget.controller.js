// controllers/budget.controller.js — FR-04.1 / FR-04.2
'use strict';
const ApiResponse = require('../utils/ApiResponse');
const budget = require('../services/budget.service');
const variance = require('../services/variance.service');

const biz = (req) => req.user.businessId;
const actor = (req) => ({ _id: req.user.id, id: req.user.id, role: req.user.role,
  fullName: req.user.fullName, email: req.user.email, approvalLevels: req.user.approvalLevels });

exports.list = async (req, res, next) => {
  try {
    return ApiResponse.success(res, await budget.list(biz(req), {
      fiscalYearId: req.query.fiscalYearId, scenario: req.query.scenario, status: req.query.status }));
  } catch (e) { next(e); }
};
exports.getOne = async (req, res, next) => {
  try { return ApiResponse.success(res, await budget.getById(biz(req), req.params.id)); } catch (e) { next(e); }
};
exports.create = async (req, res, next) => {
  try { return ApiResponse.created(res, await budget.createDraft(biz(req), req.body, actor(req)), 'Budget created.'); }
  catch (e) { next(e); }
};
exports.update = async (req, res, next) => {
  try { return ApiResponse.success(res, await budget.updateDraft(biz(req), req.params.id, req.body, actor(req)), 'Budget saved.'); }
  catch (e) { next(e); }
};
exports.seed = async (req, res, next) => {
  try { return ApiResponse.success(res, await budget.seedFromActuals(biz(req), req.body.fiscalYearId, { scenario: req.body.scenario })); }
  catch (e) { next(e); }
};
exports.submit = async (req, res, next) => {
  try { return ApiResponse.success(res, await budget.submitForApproval(biz(req), req.params.id, actor(req)), 'Budget submitted for approval.'); }
  catch (e) { next(e); }
};
exports.approve = async (req, res, next) => {
  try { return ApiResponse.success(res, await budget.approve(biz(req), req.params.id, actor(req), req.body.note), 'Budget approved.'); }
  catch (e) { next(e); }
};
exports.reject = async (req, res, next) => {
  try { return ApiResponse.success(res, await budget.reject(biz(req), req.params.id, actor(req), req.body.note), 'Budget rejected.'); }
  catch (e) { next(e); }
};
exports.clone = async (req, res, next) => {
  try { return ApiResponse.created(res, await budget.cloneVersion(biz(req), req.params.id, actor(req)), 'New draft version created.'); }
  catch (e) { next(e); }
};
exports.variance = async (req, res, next) => {
  try { return ApiResponse.success(res, await variance.computeVariance(biz(req), req.params.id, { asOf: req.query.asOf })); }
  catch (e) { next(e); }
};

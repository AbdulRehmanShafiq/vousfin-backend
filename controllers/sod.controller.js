// controllers/sod.controller.js — Phase 6B
const sodService = require('../services/sod.service');
const ApiResponse = require('../utils/ApiResponse');

exports.list = async (req, res, next) => {
  try { ApiResponse.success(res, await sodService.listRules(req.user.businessId), 'SoD rules retrieved'); }
  catch (e) { next(e); }
};
exports.add = async (req, res, next) => {
  try { ApiResponse.created(res, await sodService.addRule(req.user.businessId, req.body, req.user), 'Conflict rule added'); }
  catch (e) { next(e); }
};
exports.remove = async (req, res, next) => {
  try { ApiResponse.success(res, await sodService.removeRule(req.user.businessId, req.params.id), 'Conflict rule removed'); }
  catch (e) { next(e); }
};

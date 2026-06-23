// controllers/retention.controller.js — FR-10.4
'use strict';
const retentionService = require('../services/retention.service');
const ApiResponse = require('../utils/ApiResponse');

exports.listPolicies = async (req, res, next) => {
  try {
    const policies = await retentionService.listPolicies(req.user.businessId);
    ApiResponse.success(res, policies, 'Retention policies retrieved');
  } catch (e) { next(e); }
};

exports.setPolicies = async (req, res, next) => {
  try {
    const policies = Array.isArray(req.body) ? req.body : req.body.policies || [];
    const results = await retentionService.setPolicies(req.user.businessId, policies);
    ApiResponse.success(res, results, 'Retention policies updated');
  } catch (e) { next(e); }
};

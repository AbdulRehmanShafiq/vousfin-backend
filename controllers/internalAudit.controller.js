// controllers/internalAudit.controller.js — Phase 6C (Internal Audit)
'use strict';
const internalAuditService = require('../services/internalAudit.service');
const ApiResponse = require('../utils/ApiResponse');

exports.createPlan = async (req, res, next) => {
  try {
    ApiResponse.created(
      res,
      await internalAuditService.createPlan(req.user.businessId, req.body, req.user),
      'Audit plan created',
    );
  } catch (e) { next(e); }
};

exports.listPlans = async (req, res, next) => {
  try {
    ApiResponse.success(res, await internalAuditService.listPlans(req.user.businessId), 'Audit plans retrieved');
  } catch (e) { next(e); }
};

exports.getPlan = async (req, res, next) => {
  try {
    ApiResponse.success(res, await internalAuditService.getPlan(req.params.id, req.user.businessId), 'Audit plan retrieved');
  } catch (e) { next(e); }
};

exports.updatePlanStatus = async (req, res, next) => {
  try {
    ApiResponse.success(
      res,
      await internalAuditService.updatePlanStatus(req.params.id, req.user.businessId, req.body.status),
      'Audit plan status updated',
    );
  } catch (e) { next(e); }
};

exports.drawSample = async (req, res, next) => {
  try {
    ApiResponse.success(
      res,
      await internalAuditService.drawSample(req.params.id, req.user.businessId),
      'Sample drawn',
    );
  } catch (e) { next(e); }
};

exports.raiseFinding = async (req, res, next) => {
  try {
    ApiResponse.created(
      res,
      await internalAuditService.raiseFinding(req.user.businessId, req.body, req.user),
      'Finding raised',
    );
  } catch (e) { next(e); }
};

exports.listFindings = async (req, res, next) => {
  try {
    const { planId, status } = req.query;
    ApiResponse.success(
      res,
      await internalAuditService.listFindings(req.user.businessId, { planId, status }),
      'Findings retrieved',
    );
  } catch (e) { next(e); }
};

exports.recordResponse = async (req, res, next) => {
  try {
    ApiResponse.success(
      res,
      await internalAuditService.recordResponse(req.params.id, req.user.businessId, req.body),
      'Response recorded',
    );
  } catch (e) { next(e); }
};

exports.aging = async (req, res, next) => {
  try {
    ApiResponse.success(res, await internalAuditService.agingReport(req.user.businessId), 'Aging report retrieved');
  } catch (e) { next(e); }
};

// controllers/lease.controller.js — FR-10.2 IFRS-16
'use strict';
const leaseService = require('../services/leaseAccounting.service');
const impairmentService = require('../services/impairment.service');
const ApiResponse = require('../utils/ApiResponse');

// ── Leases ──────────────────────────────────────────────────────────────────

exports.createLease = async (req, res, next) => {
  try {
    const lease = await leaseService.createLease(req.user.businessId, req.body, req.user);
    ApiResponse.created(res, lease, 'Lease created');
  } catch (e) { next(e); }
};

exports.listLeases = async (req, res, next) => {
  try {
    const leases = await leaseService.listLeases(req.user.businessId);
    ApiResponse.success(res, leases, 'Leases retrieved');
  } catch (e) { next(e); }
};

exports.getLease = async (req, res, next) => {
  try {
    const lease = await leaseService.getLease(req.params.id, req.user.businessId);
    ApiResponse.success(res, lease, 'Lease retrieved');
  } catch (e) { next(e); }
};

exports.getSchedule = async (req, res, next) => {
  try {
    const lease = await leaseService.getLease(req.params.id, req.user.businessId);
    const schedule = leaseService.computeAmortizationSchedule(lease);
    ApiResponse.success(res, schedule, 'Amortization schedule computed');
  } catch (e) { next(e); }
};

exports.postAmortization = async (req, res, next) => {
  try {
    const je = await leaseService.postMonthlyAmortization(req.params.id, req.user.businessId);
    ApiResponse.success(res, je, 'Monthly amortization posted');
  } catch (e) { next(e); }
};

exports.terminateLease = async (req, res, next) => {
  try {
    const lease = await leaseService.terminateLease(req.params.id, req.user.businessId);
    ApiResponse.success(res, lease, 'Lease terminated');
  } catch (e) { next(e); }
};

// ── Impairment ───────────────────────────────────────────────────────────────

exports.createAssessment = async (req, res, next) => {
  try {
    const check = await impairmentService.createAssessment(req.user.businessId, req.body, req.user);
    ApiResponse.created(res, check, 'Impairment assessment created');
  } catch (e) { next(e); }
};

exports.listAssessments = async (req, res, next) => {
  try {
    const checks = await impairmentService.listAssessments(req.user.businessId);
    ApiResponse.success(res, checks, 'Impairment assessments retrieved');
  } catch (e) { next(e); }
};

exports.postImpairmentLoss = async (req, res, next) => {
  try {
    const je = await impairmentService.postImpairmentLoss(req.params.id, req.user.businessId);
    ApiResponse.success(res, je, 'Impairment loss posted to ledger');
  } catch (e) { next(e); }
};

exports.getIndicators = async (req, res, next) => {
  try {
    ApiResponse.success(res, impairmentService.constructor.IAS36_INDICATORS || require('../services/impairment.service').constructor.IAS36_INDICATORS, 'IAS-36 indicators');
  } catch (e) { next(e); }
};

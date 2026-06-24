// controllers/compliance.controller.js — FR-10.1
'use strict';
const complianceService = require('../services/compliance.service');
const ApiResponse = require('../utils/ApiResponse');

exports.generate = async (req, res, next) => {
  try {
    const year = req.body.year; // Joi-validated integer 2000-2100
    const count = await complianceService.generateObligations(req.user.businessId, year);
    ApiResponse.success(res, { generated: count, year }, `Generated ${count} obligation records for ${year}`);
  } catch (e) { next(e); }
};

exports.list = async (req, res, next) => {
  try {
    const { year, month, status } = req.query;
    const obligations = await complianceService.listObligations(req.user.businessId, { year, month, status });
    const enriched = complianceService.enrichWithTemplate(obligations);
    ApiResponse.success(res, enriched, 'Obligations retrieved');
  } catch (e) { next(e); }
};

exports.complete = async (req, res, next) => {
  try {
    const obl = await complianceService.completeObligation(req.params.id, req.user.businessId, req.body, req.user);
    ApiResponse.success(res, obl, 'Obligation marked complete');
  } catch (e) { next(e); }
};

exports.waive = async (req, res, next) => {
  try {
    const obl = await complianceService.waiveObligation(req.params.id, req.user.businessId, req.body, req.user);
    ApiResponse.success(res, obl, 'Obligation waived');
  } catch (e) { next(e); }
};

exports.checkOverdue = async (req, res, next) => {
  try {
    const count = await complianceService.checkAndMarkOverdue(req.user.businessId);
    ApiResponse.success(res, { marked: count }, `Marked ${count} obligations as overdue`);
  } catch (e) { next(e); }
};

exports.upcoming = async (req, res, next) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const obligations = await complianceService.upcomingReminders(req.user.businessId, days);
    const enriched = complianceService.enrichWithTemplate(obligations);
    ApiResponse.success(res, enriched, `Upcoming obligations in the next ${days} days`);
  } catch (e) { next(e); }
};

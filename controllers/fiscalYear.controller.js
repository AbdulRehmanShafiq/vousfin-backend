// controllers/fiscalYear.controller.js — Phase 5.1 Accounting Period Engine
'use strict';

const fiscalYearService = require('../services/fiscalYear.service');
const ApiResponse       = require('../utils/ApiResponse');
const { ApiError }      = require('../utils/ApiError');

/* ── Fiscal Years ─────────────────────────────────────────────────────────── */

const createFiscalYear = async (req, res, next) => {
  try {
    const { name, startDate, endDate } = req.body;
    if (!name || !startDate || !endDate) {
      throw new ApiError(400, 'name, startDate and endDate are required');
    }
    const fy = await fiscalYearService.createFiscalYear(
      req.user.businessId, { name, startDate, endDate }, req.user._id || req.user.id
    );
    ApiResponse.success(res, fy, 'Fiscal year created', 201);
  } catch (err) { next(err); }
};

const listFiscalYears = async (req, res, next) => {
  try {
    const years = await fiscalYearService.listFiscalYears(req.user.businessId);
    ApiResponse.success(res, years, 'Fiscal years retrieved');
  } catch (err) { next(err); }
};

const getFiscalYear = async (req, res, next) => {
  try {
    const fy = await fiscalYearService.getFiscalYear(req.user.businessId, req.params.id);
    ApiResponse.success(res, fy, 'Fiscal year retrieved');
  } catch (err) { next(err); }
};

const closeFiscalYear = async (req, res, next) => {
  try {
    const { reason = '' } = req.body || {};
    const result = await fiscalYearService.closeFiscalYear(
      req.user.businessId, req.params.id, req.user._id || req.user.id, { reason }
    );
    ApiResponse.success(res, result, 'Fiscal year closed and closing entries generated');
  } catch (err) { next(err); }
};

const lockFiscalYear = async (req, res, next) => {
  try {
    const { reason = '' } = req.body || {};
    const result = await fiscalYearService.lockFiscalYear(
      req.user.businessId, req.params.id, req.user._id || req.user.id, { reason }
    );
    ApiResponse.success(res, result, 'Fiscal year permanently locked');
  } catch (err) { next(err); }
};

/* ── Accounting Periods ───────────────────────────────────────────────────── */

const getPeriodsForYear = async (req, res, next) => {
  try {
    const periods = await fiscalYearService.getPeriodsForYear(
      req.user.businessId, req.params.id
    );
    ApiResponse.success(res, periods, 'Accounting periods retrieved');
  } catch (err) { next(err); }
};

const closePeriod = async (req, res, next) => {
  try {
    const { reason = '' } = req.body || {};
    const result = await fiscalYearService.closePeriod(
      req.user.businessId, req.params.periodId, req.user._id || req.user.id, { reason }
    );
    ApiResponse.success(res, result, `Period closed`);
  } catch (err) { next(err); }
};

const lockPeriod = async (req, res, next) => {
  try {
    const { reason = '' } = req.body || {};
    const result = await fiscalYearService.lockPeriod(
      req.user.businessId, req.params.periodId, req.user._id || req.user.id, { reason }
    );
    ApiResponse.success(res, result, 'Period locked');
  } catch (err) { next(err); }
};

const reopenPeriod = async (req, res, next) => {
  try {
    const { reason = '' } = req.body || {};
    const result = await fiscalYearService.reopenPeriod(
      req.user.businessId, req.params.periodId, req.user._id || req.user.id, { reason, isAdminOverride: true }
    );
    ApiResponse.success(res, result, 'Period reopened');
  } catch (err) { next(err); }
};

/* ── Adjusting Entries ────────────────────────────────────────────────────── */

const postAdjustingEntry = async (req, res, next) => {
  try {
    const {
      adjustingType, periodId, description,
      amount, debitAccountId, creditAccountId, memo,
    } = req.body;
    if (!adjustingType || !periodId || !amount || !debitAccountId || !creditAccountId) {
      throw new ApiError(400, 'adjustingType, periodId, amount, debitAccountId, creditAccountId required');
    }
    const entry = await fiscalYearService.postAdjustingEntry(
      req.user.businessId,
      { adjustingType, periodId, description, amount, debitAccountId, creditAccountId, memo },
      req.user._id || req.user.id
    );
    ApiResponse.success(res, entry, 'Adjusting entry posted', 201);
  } catch (err) { next(err); }
};

/* ── Current Period (for UI banner) ──────────────────────────────────────── */

const getCurrentPeriod = async (req, res, next) => {
  try {
    const period = await fiscalYearService.getCurrentPeriod(req.user.businessId);
    ApiResponse.success(res, period || null, 'Current period retrieved');
  } catch (err) { next(err); }
};

module.exports = {
  createFiscalYear, listFiscalYears, getFiscalYear,
  closeFiscalYear, lockFiscalYear,
  getPeriodsForYear, closePeriod, lockPeriod, reopenPeriod,
  postAdjustingEntry, getCurrentPeriod,
};

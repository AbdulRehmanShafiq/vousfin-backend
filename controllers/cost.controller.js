// controllers/cost.controller.js — FR-07.2/.3/.4
'use strict';
const ApiResponse = require('../utils/ApiResponse');
const jobCosting = require('../services/jobCosting.service');
const profitability = require('../services/profitability.service');
const breakEven = require('../services/breakEven.service');

const biz = (req) => req.user.businessId;
const actor = (req) => ({ id: req.user.id, role: req.user.role });

exports.listJobs = async (req, res, next) => { try { return ApiResponse.success(res, await jobCosting.listJobs(biz(req), { status: req.query.status, customerId: req.query.customerId })); } catch (e) { next(e); } };
exports.getJob = async (req, res, next) => { try { return ApiResponse.success(res, await jobCosting.getJob(biz(req), req.params.id)); } catch (e) { next(e); } };
exports.createJob = async (req, res, next) => { try { return ApiResponse.created(res, await jobCosting.createJob(biz(req), req.body, actor(req)), 'Job created.'); } catch (e) { next(e); } };
exports.addCost = async (req, res, next) => { try { return ApiResponse.success(res, await jobCosting.addCost(biz(req), req.params.id, req.body, actor(req)), 'Cost added.'); } catch (e) { next(e); } };
exports.completeJob = async (req, res, next) => { try { return ApiResponse.success(res, await jobCosting.completeJob(biz(req), req.params.id, actor(req)), 'Job completed.'); } catch (e) { next(e); } };
exports.cancelJob = async (req, res, next) => { try { return ApiResponse.success(res, await jobCosting.cancelJob(biz(req), req.params.id, actor(req)), 'Job cancelled.'); } catch (e) { next(e); } };
exports.profitability = async (req, res, next) => { try { return ApiResponse.success(res, await profitability.byDimension(biz(req), req.query.dim, { from: req.query.from, to: req.query.to })); } catch (e) { next(e); } };
exports.breakEven = async (req, res, next) => { try { return ApiResponse.success(res, breakEven.breakEvenPoint(req.body)); } catch (e) { next(e); } };
exports.whatIf = async (req, res, next) => { try { return ApiResponse.success(res, breakEven.whatIf(req.body)); } catch (e) { next(e); } };
exports.estimate = async (req, res, next) => { try { return ApiResponse.success(res, await breakEven.estimateFromActuals(biz(req), { from: req.query.from, to: req.query.to })); } catch (e) { next(e); } };

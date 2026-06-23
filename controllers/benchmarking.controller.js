// controllers/benchmarking.controller.js — Phase 8 FR-09.3
'use strict';
const benchmarkingService = require('../services/benchmarking.service');
const ApiResponse = require('../utils/ApiResponse');

exports.getBenchmark = async (req, res, next) => {
  try {
    const data = await benchmarkingService.getBenchmark(req.user.businessId);
    ApiResponse.success(res, data, 'Industry benchmarks retrieved');
  } catch (e) { next(e); }
};

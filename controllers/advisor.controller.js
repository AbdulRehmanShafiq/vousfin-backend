// controllers/advisor.controller.js — Proactive AI CFO feed (Intelligence
// Roadmap Phase 4).
'use strict';
const advisorService = require('../services/advisor.service');
const ApiResponse = require('../utils/ApiResponse');

exports.getRecommendations = async (req, res, next) => {
  try {
    const result = await advisorService.getRecommendations(req.user.businessId);
    ApiResponse.success(res, result, 'Advisor recommendations');
  } catch (err) { next(err); }
};

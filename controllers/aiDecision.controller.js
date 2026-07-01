// controllers/aiDecision.controller.js — read surface for the AI Decision Ledger.
'use strict';
const aiDecisionService = require('../services/aiDecision.service');
const ApiResponse = require('../utils/ApiResponse');
const { ApiError } = require('../utils/ApiError');

exports.list = async (req, res, next) => {
  try {
    const { kind, outcome, page, limit } = req.query;
    const result = await aiDecisionService.list(req.user.businessId, {
      kind, outcome,
      page: Number(page) || 1,
      limit: Math.min(Number(limit) || 25, 100),
    });
    ApiResponse.success(res, result, 'AI decisions');
  } catch (err) { next(err); }
};

exports.getById = async (req, res, next) => {
  try {
    const doc = await aiDecisionService.getById(req.params.id, req.user.businessId);
    if (!doc) throw new ApiError(404, 'AI decision not found');
    ApiResponse.success(res, doc, 'AI decision');
  } catch (err) { next(err); }
};

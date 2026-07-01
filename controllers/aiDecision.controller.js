// controllers/aiDecision.controller.js — read + review surface for the AI
// Decision Ledger (Phase 0 lineage, Phase 2 explainability, Phase 1 calibration).
'use strict';
const aiDecisionService = require('../services/aiDecision.service');
const aiExplainService = require('../services/aiExplain.service');
const aiCalibrationService = require('../services/aiCalibration.service');
const learnedResolution = require('../services/learnedResolution.service');
const { AUTO_POST_THRESHOLD } = require('../services/nlParser/utils/confidenceCalculator');
const { AI_DECISION_OUTCOMES } = require('../config/constants');
const ApiResponse = require('../utils/ApiResponse');
const { ApiError } = require('../utils/ApiError');

const SETTABLE_OUTCOMES = new Set([
  AI_DECISION_OUTCOMES.ACCEPTED, AI_DECISION_OUTCOMES.CORRECTED, AI_DECISION_OUTCOMES.REVERSED,
]);

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

// GET /:id/explain — Phase 2: grounded plain-language "why" for a decision.
exports.explain = async (req, res, next) => {
  try {
    const result = await aiExplainService.explainById(req.params.id, req.user.businessId);
    if (!result) throw new ApiError(404, 'AI decision not found');
    ApiResponse.success(res, result, 'AI decision explained');
  } catch (err) { next(err); }
};

// POST /:id/outcome — Phase 2: one-click accept/correct/reverse from the review
// UI. A correction feeds the Phase 1 learning loop. Propagates real error
// semantics (404 not found, 409 already resolved, 400 invalid outcome).
exports.setOutcome = async (req, res, next) => {
  try {
    const { outcome, correctedTo = null } = req.body;
    if (!SETTABLE_OUTCOMES.has(outcome)) {
      throw new ApiError(400, `Invalid outcome. Use one of: ${[...SETTABLE_OUTCOMES].join(', ')}.`);
    }
    const existing = await aiDecisionService.getById(req.params.id, req.user.businessId);
    if (!existing) throw new ApiError(404, 'AI decision not found');

    let updated;
    try {
      updated = await aiDecisionService.applyUserOutcome(req.params.id, req.user.businessId, outcome, correctedTo);
    } catch (e) {
      if (/already set/i.test(e.message)) throw new ApiError(409, 'This AI decision has already been reviewed.');
      throw e;
    }
    if (!updated) throw new ApiError(404, 'AI decision not found');

    // A correction with concrete accounts becomes a labeled learning signal.
    if (
      outcome === AI_DECISION_OUTCOMES.CORRECTED &&
      correctedTo && correctedTo.debitAccountName && correctedTo.creditAccountName
    ) {
      await learnedResolution.learnAccountsFromConfirmation(req.user.businessId, existing.inputsSummary, {
        debitAccountName: correctedTo.debitAccountName,
        creditAccountName: correctedTo.creditAccountName,
      });
    }
    ApiResponse.success(res, updated, 'AI decision outcome recorded');
  } catch (err) { next(err); }
};

// GET /stats — Phase 1: measured acceptance/reversal stats + the tenant's
// effective (conservative-only) auto-post threshold.
exports.stats = async (req, res, next) => {
  try {
    const [stats, effectiveAutoPostThreshold] = await Promise.all([
      aiCalibrationService.computeAcceptanceStats(req.user.businessId, { kind: req.query.kind }),
      aiCalibrationService.getEffectiveAutoPostThreshold(req.user.businessId, AUTO_POST_THRESHOLD),
    ]);
    ApiResponse.success(
      res,
      { stats, baseAutoPostThreshold: AUTO_POST_THRESHOLD, effectiveAutoPostThreshold },
      'AI calibration stats',
    );
  } catch (err) { next(err); }
};

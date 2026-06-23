// controllers/aml.controller.js — FR-10.3
'use strict';
const amlService = require('../services/amlScreening.service');
const ApiResponse = require('../utils/ApiResponse');

exports.list = async (req, res, next) => {
  try {
    const screenings = await amlService.listScreenings(req.user.businessId, req.query);
    ApiResponse.success(res, screenings, 'Screenings retrieved');
  } catch (e) { next(e); }
};

exports.draftSTR = async (req, res, next) => {
  try {
    const draft = await amlService.draftSTR(req.params.id, req.user.businessId);
    ApiResponse.success(res, draft, 'STR draft generated');
  } catch (e) { next(e); }
};

exports.addJustification = async (req, res, next) => {
  try {
    const s = await amlService.addJustification(req.params.id, req.user.businessId, {
      justification: req.body.justification,
      reviewedBy: req.user._id || req.user.id,
    });
    ApiResponse.success(res, s, 'Justification added');
  } catch (e) { next(e); }
};

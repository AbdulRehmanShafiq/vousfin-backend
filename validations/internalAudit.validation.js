// validations/internalAudit.validation.js — Phase 6C
'use strict';
const Joi = require('joi');

const hex24 = Joi.string().pattern(/^[a-f\d]{24}$/i).message('Must be a valid 24-character hex ID');

const createPlanSchema = Joi.object({
  name:           Joi.string().trim().max(120).required(),
  scope:          Joi.string().max(300).allow('', null),
  periodStart:    Joi.date().iso().required(),
  periodEnd:      Joi.date().iso().min(Joi.ref('periodStart')).required()
                    .messages({ 'date.min': 'periodEnd must be on or after periodStart' }),
  sampleStrategy: Joi.string().valid('random', 'risk_based'),
  sampleSize:     Joi.number().integer().min(1).max(100),
});

const raiseFindingSchema = Joi.object({
  planId:              hex24.required(),
  linkedEntityId:      hex24.allow('', null),
  linkedEntityType:    Joi.string().max(60).allow('', null),
  observation:         Joi.string().trim().max(1000).required(),
  riskRating:          Joi.string().valid('critical', 'high', 'medium', 'low'),
  targetResolutionDate:Joi.date().iso().allow(null),
});

const recordResponseSchema = Joi.object({
  managementResponse:  Joi.string().max(1000).allow('', null),
  targetResolutionDate:Joi.date().iso().allow(null),
  status:              Joi.string().valid('open', 'in_progress', 'resolved'),
});

const planStatusSchema = Joi.object({
  status: Joi.string().valid('draft', 'in_progress', 'completed').required(),
});

module.exports = { createPlanSchema, raiseFindingSchema, recordResponseSchema, planStatusSchema };

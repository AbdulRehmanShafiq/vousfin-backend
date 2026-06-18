// validations/budget.validation.js — FR-04.1
'use strict';
const Joi = require('joi');

const objectId = Joi.string().hex().length(24);

const lineSchema = Joi.object({
  accountId: objectId.required(),
  costCenterId: objectId.allow(null, ''),
  monthly: Joi.array().items(Joi.number()).length(12).required(),
  thresholdPct: Joi.number().min(0).allow(null),
});

const createBudgetSchema = Joi.object({
  name: Joi.string().max(120).required(),
  fiscalYearId: objectId.required(),
  scenario: Joi.string().valid('base', 'optimistic', 'pessimistic').default('base'),
  defaultThresholdPct: Joi.number().min(0).default(10),
  lines: Joi.array().items(lineSchema).default([]),
});

const updateBudgetSchema = Joi.object({
  name: Joi.string().max(120),
  defaultThresholdPct: Joi.number().min(0),
  lines: Joi.array().items(lineSchema),
}).min(1);

const seedSchema = Joi.object({
  fiscalYearId: objectId.required(),
  scenario: Joi.string().valid('base', 'optimistic', 'pessimistic').default('base'),
});

const approvalNoteSchema = Joi.object({ note: Joi.string().allow('', null) });

module.exports = { createBudgetSchema, updateBudgetSchema, seedSchema, approvalNoteSchema };

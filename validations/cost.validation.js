// validations/cost.validation.js — FR-07
'use strict';
const Joi = require('joi');
const objectId = Joi.string().hex().length(24);
const money = Joi.number().min(0);

const createJobSchema = Joi.object({
  code: Joi.string().max(40).required(),
  name: Joi.string().max(160).required(),
  customerId: objectId.allow(null, ''),
  standardCost: Joi.object({ material: money, labour: money, overhead: money }).default({}),
});
const addCostSchema = Joi.object({
  category: Joi.string().valid('material', 'labour', 'overhead').required(),
  amount: Joi.number().greater(0).required(),
  sourceAccountId: objectId.required(),
  description: Joi.string().allow('', null),
});
const breakEvenSchema = Joi.object({
  fixedCosts: money.required(), pricePerUnit: money.required(), variableCostPerUnit: money.required(),
});
const whatIfSchema = breakEvenSchema.keys({
  expectedUnits: Joi.number().min(0).default(0), targetProfit: Joi.number().default(0),
});
module.exports = { createJobSchema, addCostSchema, breakEvenSchema, whatIfSchema };

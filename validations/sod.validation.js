// validations/sod.validation.js — Phase 6B
const Joi = require('joi');
const { BUSINESS_ROLES } = require('../config/constants');
const ROLES = Object.values(BUSINESS_ROLES);

const addRuleSchema = Joi.object({
  roleA: Joi.string().valid(...ROLES).required(),
  roleB: Joi.string().valid(...ROLES).required(),
  reason: Joi.string().max(300).allow('', null),
});

module.exports = { addRuleSchema };

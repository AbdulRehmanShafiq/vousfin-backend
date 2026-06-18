// validations/costCenter.validation.js — SRS FR-07.1
const Joi = require('joi');
const { COST_CENTER_TYPES } = require('../config/constants');

const TYPES = Object.values(COST_CENTER_TYPES);

const createCostCenterSchema = Joi.object({
  code: Joi.string().min(1).max(30).required().trim().messages({
    'any.required': 'Cost centre code is required',
    'string.max': 'Code cannot exceed 30 characters',
  }),
  name: Joi.string().min(2).max(120).required().trim().messages({
    'any.required': 'Cost centre name is required',
    'string.min': 'Name must be at least 2 characters',
  }),
  type: Joi.string().valid(...TYPES).default(COST_CENTER_TYPES.DEPARTMENT),
  parentId: Joi.string().hex().length(24).allow(null, '').optional(),
  description: Joi.string().max(300).allow('', null).trim().optional(),
  isActive: Joi.boolean().default(true).optional(),
});

const updateCostCenterSchema = Joi.object({
  code: Joi.string().min(1).max(30).trim().optional(),
  name: Joi.string().min(2).max(120).trim().optional(),
  type: Joi.string().valid(...TYPES).optional(),
  parentId: Joi.string().hex().length(24).allow(null, '').optional(),
  description: Joi.string().max(300).allow('', null).trim().optional(),
  isActive: Joi.boolean().optional(),
}).min(1);

module.exports = { createCostCenterSchema, updateCostCenterSchema };

// validations/team.validation.js — Phase 6A
'use strict';
const Joi = require('joi');
const { BUSINESS_ROLES } = require('../config/constants');
const ROLES = Object.values(BUSINESS_ROLES);

const inviteSchema = Joi.object({
  email: Joi.string().email().required().messages({ 'any.required': 'An email address is required' }),
  roles: Joi.array().items(Joi.string().valid(...ROLES)).min(1).required(),
});

const updateRolesSchema = Joi.object({
  roles: Joi.array().items(Joi.string().valid(...ROLES)).min(1).required(),
});

const acceptSchema = Joi.object({ token: Joi.string().required() });

module.exports = { inviteSchema, updateRolesSchema, acceptSchema };

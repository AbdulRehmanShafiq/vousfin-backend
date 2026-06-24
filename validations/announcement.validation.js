'use strict';
const Joi = require('joi');

const createSchema = Joi.object({
  title:     Joi.string().trim().max(160).required(),
  body:      Joi.string().trim().max(1000).required(),
  type:      Joi.string().valid('info', 'warning', 'success').default('info'),
  active:    Joi.boolean().default(true),
  expiresAt: Joi.date().iso().allow(null),
});

const updateSchema = Joi.object({
  title:     Joi.string().trim().max(160),
  body:      Joi.string().trim().max(1000),
  type:      Joi.string().valid('info', 'warning', 'success'),
  active:    Joi.boolean(),
  expiresAt: Joi.date().iso().allow(null),
});

module.exports = { createSchema, updateSchema };

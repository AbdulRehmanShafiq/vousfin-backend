'use strict';
const Joi = require('joi');

const submitSchema = Joi.object({
  type:    Joi.string().valid('bug', 'feature', 'general', 'praise', 'other').default('general'),
  subject: Joi.string().trim().max(200).allow('', null),
  message: Joi.string().trim().max(4000).required(),
  rating:  Joi.number().integer().min(1).max(5).allow(null),
  name:    Joi.string().trim().max(120).allow('', null),
  email:   Joi.string().email().allow('', null),
});

const updateStatusSchema = Joi.object({
  status:    Joi.string().valid('new', 'reviewed', 'resolved'),
  adminNote: Joi.string().allow('', null),
});

module.exports = { submitSchema, updateStatusSchema };

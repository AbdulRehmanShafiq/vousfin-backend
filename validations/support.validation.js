'use strict';
const Joi = require('joi');

const createTicketSchema = Joi.object({
  subject:  Joi.string().trim().max(200).required(),
  category: Joi.string().valid('question', 'problem', 'billing', 'other').default('question'),
  priority: Joi.string().valid('low', 'normal', 'high', 'urgent').default('normal'),
  message:  Joi.string().trim().required(),
});

const replySchema = Joi.object({
  body: Joi.string().trim().required(),
});

const updateTicketSchema = Joi.object({
  status:   Joi.string().valid('open', 'in_progress', 'resolved', 'closed'),
  priority: Joi.string().valid('low', 'normal', 'high', 'urgent'),
});

module.exports = { createTicketSchema, replySchema, updateTicketSchema };

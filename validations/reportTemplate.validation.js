'use strict';

const Joi = require('joi');

const layoutRow = Joi.object({
  id: Joi.string().required(),
  kind: Joi.string().valid('section', 'account-group', 'account', 'subtotal', 'spacer').required(),
  label: Joi.string().allow('').default(''),
  accountType: Joi.string().optional(),
  accountSubtype: Joi.string().optional(),
  accountIds: Joi.array().items(Joi.string().hex().length(24)).optional(),
  metric: Joi.string().valid('balance', 'flow').default('balance'),
  visible: Joi.boolean().default(true),
});

const comparative = Joi.object({
  enabled: Joi.boolean().default(false),
  mode: Joi.string().valid('prior-period', 'prior-year', 'custom').default('prior-period'),
  priorStart: Joi.date().iso().optional(),
  priorEnd: Joi.date().iso().optional(),
});

const createTemplateSchema = Joi.object({
  name: Joi.string().max(120).required(),
  baseType: Joi.string().valid('pl', 'bs', 'custom').default('custom'),
  layout: Joi.array().items(layoutRow).default([]),
  filters: Joi.object({ costCenterId: Joi.string().hex().length(24).allow(null) }).default({}),
  comparative: comparative.default({ enabled: false }),
});

const updateTemplateSchema = createTemplateSchema.fork(['name'], (s) => s.optional());

const renderSchema = Joi.object({
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  asOfDate: Joi.date().iso().optional(),
});

const previewSchema = createTemplateSchema.keys({
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  asOfDate: Joi.date().iso().optional(),
});

const scheduleSchema = Joi.object({
  enabled: Joi.boolean().required(),
  frequency: Joi.string().valid('daily', 'weekly', 'monthly').default('monthly'),
  dayOfWeek: Joi.number().min(0).max(6).default(1),
  dayOfMonth: Joi.number().min(1).max(28).default(1),
  hour: Joi.number().min(0).max(23).default(6),
  recipients: Joi.array().items(Joi.string().email()).default([]),
});

module.exports = {
  createTemplateSchema, updateTemplateSchema, renderSchema, previewSchema, scheduleSchema,
};

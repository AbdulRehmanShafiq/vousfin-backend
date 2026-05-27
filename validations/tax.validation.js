/**
 * tax.validation.js — Phase 5.4.3
 * Joi schemas for the /tax/* endpoints.
 */
'use strict';

const Joi = require('joi');
const { SUPPORTED_COUNTRIES, TRANSACTION_TYPES, TAX_TYPES } = require('../config/constants');

/** PUT /tax/config */
const updateTaxConfigSchema = Joi.object({
  country:               Joi.string().valid(...SUPPORTED_COUNTRIES).uppercase().optional(),
  taxRegistrationNumber: Joi.string().max(50).allow(null, '').optional(),
  gstEnabled:            Joi.boolean().optional(),
  vatEnabled:            Joi.boolean().optional(),
  whtEnabled:            Joi.boolean().optional(),
  reverseChargeEnabled:  Joi.boolean().optional(),
  registeredForTax:      Joi.boolean().optional(),
  taxInclusive:          Joi.boolean().optional(),
  filingFrequency:       Joi.string().valid('monthly', 'quarterly', 'annual').optional(),
  customRates:           Joi.object().pattern(
    Joi.string(),                          // tax type key
    Joi.number().min(0).max(100)           // rate %
  ).optional(),
}).min(1);

/** POST /tax/enable */
const enableTaxSchema = Joi.object({
  country: Joi.string().valid(...SUPPORTED_COUNTRIES).uppercase().required(),
});

/** POST /tax/preview */
const taxPreviewSchema = Joi.object({
  amount:          Joi.number().positive().required(),
  transactionType: Joi.string().valid(...Object.values(TRANSACTION_TYPES)).required(),
  mode:            Joi.string().valid('inclusive', 'exclusive').default('inclusive'),
  taxType:         Joi.string().max(30).uppercase().allow(null, '').optional(),
  taxRate:         Joi.number().min(0).max(100).optional(),
  isReverseCharge: Joi.boolean().optional(),
  whtCategory:     Joi.string().max(50).allow(null, '').optional(),
});

/** GET /tax/profiles/:code */
const countryCodeParamSchema = Joi.object({
  code: Joi.string().valid(...SUPPORTED_COUNTRIES).uppercase().required(),
});

module.exports = {
  updateTaxConfigSchema,
  enableTaxSchema,
  taxPreviewSchema,
  countryCodeParamSchema,
};

// validations/fixedAsset.validation.js
'use strict';
const Joi = require('joi');

const createAssetSchema = Joi.object({
  name: Joi.string().trim().max(200).required(),
  category: Joi.string().trim().max(80).allow('', null),
  acquisitionDate: Joi.date().iso().required(),
  acquisitionCost: Joi.number().min(0).required(),
  salvageValue: Joi.number().min(0).max(Joi.ref('acquisitionCost')).default(0)
    .messages({ 'number.max': 'Salvage value cannot exceed the acquisition cost.' }),
  usefulLifeYears: Joi.number().integer().min(1).max(100).required(),
  depreciationMethod: Joi.string().valid('straight_line', 'declining_balance').default('straight_line'),
  assetAccountCode: Joi.string().trim().max(10).default('1220'),
});

const disposeSchema = Joi.object({
  disposalDate: Joi.date().iso().required(),
  proceeds: Joi.number().min(0).default(0),
});

module.exports = { createAssetSchema, disposeSchema };

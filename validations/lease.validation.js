// validations/lease.validation.js — FR-10.2 IFRS-16 Leases + IAS-36 Impairment
// Also exports AML justify, compliance generate, and 13-week query schemas.
'use strict';
const Joi = require('joi');

// ── Lease ─────────────────────────────────────────────────────────────────────
const createLeaseSchema = Joi.object({
  assetName:        Joi.string().trim().max(200).required(),
  commencementDate: Joi.date().iso().required(),
  leaseTerm:        Joi.number().integer().min(1).max(600).required(),
  monthlyPayment:   Joi.number().min(0).required(),
  discountRate:     Joi.number().min(0).max(1).required(),
  currency:         Joi.string().max(10).allow('', null),
});

// ── Impairment ────────────────────────────────────────────────────────────────
const createImpairmentSchema = Joi.object({
  assetName:         Joi.string().trim().max(200).required(),
  carryingAmount:    Joi.number().min(0).required(),
  recoverableAmount: Joi.number().min(0).required(),
  indicators:        Joi.array().items(Joi.string()).default([]),
  assessmentDate:    Joi.date().iso().allow(null),
  assetAccountId:    Joi.string().pattern(/^[a-f\d]{24}$/i).allow('', null),
});

// ── AML justify ───────────────────────────────────────────────────────────────
const amlJustifySchema = Joi.object({
  justification: Joi.string().max(1000).allow('', null),
});

// ── Compliance generate ───────────────────────────────────────────────────────
const complianceGenerateSchema = Joi.object({
  year: Joi.number().integer().min(2000).max(2100).required(),
});

// ── 13-week cash flow query ───────────────────────────────────────────────────
const thirteenWeekQuerySchema = Joi.object({
  floor: Joi.number().min(0).default(0),
});

module.exports = {
  createLeaseSchema,
  createImpairmentSchema,
  amlJustifySchema,
  complianceGenerateSchema,
  thirteenWeekQuerySchema,
};

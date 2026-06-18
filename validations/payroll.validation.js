// validations/payroll.validation.js — FR-08
'use strict';
const Joi = require('joi');

const objectId = Joi.string().hex().length(24);
const money = Joi.number().min(0);

const salaryVersion = Joi.object({
  effectiveFrom: Joi.date().required(),
  basic: money.required(),
  allowances: Joi.object({
    houseRent: money, medical: money, conveyance: money, special: money, other: money,
  }).default({}),
  taxExempt: Joi.object({ medicalCapPctOfBasic: Joi.number().min(0).max(100) }).default({}),
  eobi: Joi.object({ enabled: Joi.boolean(), employeeAmount: money, employerAmount: money }).default({}),
  providentFund: Joi.object({
    enabled: Joi.boolean(), employeePctOfBasic: Joi.number().min(0).max(100), employerPctOfBasic: Joi.number().min(0).max(100),
  }).default({}),
  recurringDeductions: Joi.array().items(Joi.object({ label: Joi.string().required(), amount: money.required() })).default([]),
});

const createEmployeeSchema = Joi.object({
  code: Joi.string().required(), fullName: Joi.string().required(),
  cnic: Joi.string().allow(''), ntn: Joi.string().allow(''), email: Joi.string().allow(''),
  phone: Joi.string().allow(''), designation: Joi.string().allow(''),
  department: objectId.allow(null), joiningDate: Joi.date().allow(null),
  bankName: Joi.string().allow(''), bankAccountTitle: Joi.string().allow(''), iban: Joi.string().allow(''),
  status: Joi.string().valid('active', 'inactive'),
  salaryStructure: Joi.array().items(salaryVersion).min(1).required(),
});

const updateEmployeeSchema = createEmployeeSchema.fork(
  ['code', 'fullName', 'salaryStructure'], (s) => s.optional()
);

const adjustment = Joi.object({
  additions: Joi.array().items(Joi.object({ label: Joi.string().required(), amount: money.required() })),
  deductions: Joi.array().items(Joi.object({ label: Joi.string().required(), amount: money.required() })),
});

const processRunSchema = Joi.object({
  period: Joi.string().pattern(/^\d{4}-\d{2}$/).required(),
  employeeIds: Joi.array().items(objectId),
  adjustments: Joi.object().pattern(objectId, adjustment).default({}),
});

const payRunSchema = Joi.object({ bankAccountId: objectId.required() });

module.exports = { createEmployeeSchema, updateEmployeeSchema, processRunSchema, payRunSchema };

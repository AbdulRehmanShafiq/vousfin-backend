// validations/invoice.validation.js — AR/AP Domain Refactor, Milestone M4 (API layer)
'use strict';

const Joi = require('joi');

const objectId = Joi.string().hex().length(24);

const lineItem = Joi.object({
  name:          Joi.string().trim().max(300).required(),
  quantity:      Joi.number().positive().required(),
  unitPrice:     Joi.number().min(0).required(),
  taxRate:       Joi.number().min(0).max(100),
  discountValue: Joi.number().min(0),
  discountType:  Joi.string().valid('percentage', 'fixed').allow(null),
}).unknown(true);

// Money / FX / dates shared by create + update.
const shared = {
  invoiceNumber:        Joi.string().trim().max(100),
  customerId:           objectId.allow(null, ''),
  issueDate:            Joi.date(),
  dueDate:              Joi.date().min(Joi.ref('issueDate')).messages({
    'date.min': 'dueDate cannot be earlier than issueDate',
  }),
  currencyCode:         Joi.string().uppercase().length(3),
  exchangeRate:         Joi.number().positive(),
  amount:               Joi.number().positive(),
  taxAmount:            Joi.number().min(0),
  shippingCharges:      Joi.number().min(0),
  roundingAdjustment:   Joi.number(),
  invoiceDiscountValue: Joi.number().min(0),
  lineItems:            Joi.array().items(lineItem),
};

const createInvoiceSchema = Joi.object({
  ...shared,
  invoiceNumber: shared.invoiceNumber.required(),
  issueDate:     shared.issueDate.required(),
})
  .or('amount', 'lineItems')   // at least one source of value
  .unknown(true);

const updateInvoiceSchema = Joi.object({ ...shared }).unknown(true);

module.exports = { createInvoiceSchema, updateInvoiceSchema };

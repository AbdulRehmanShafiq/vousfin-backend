/**
 * arApValidation.js — AR/AP Domain Refactor, Milestone M4.
 *
 * Enterprise-grade, SERVICE-layer business validation shared by invoice.service
 * and bill.service. Pure of model/repo imports (callers inject them) to stay
 * dependency-free and trivially testable. Throws ApiError so the global handler
 * returns a clean 400/409. Complements the model validators (field-level) and
 * the Joi schemas (request shape) for defense-in-depth across all three layers.
 */

'use strict';

const { ApiError } = require('./ApiError');

const CURRENCY_RE = /^[A-Z]{3}$/;
const num = (v) => Number(v);

/**
 * Validate the shape + cross-field business rules of an invoice/bill payload.
 * @param {Object} data
 * @param {Object} [opts] { kind: 'invoice'|'bill', isUpdate: boolean }
 */
function validateDocumentData(data, { kind = 'invoice', isUpdate = false } = {}) {
  const numField = kind === 'invoice' ? 'invoiceNumber' : 'billNumber';
  const label = kind === 'invoice' ? 'Invoice' : 'Bill';
  const hasLines = Array.isArray(data.lineItems) && data.lineItems.length > 0;

  // ── Required identity (create only) ──────────────────────────────────────
  if (!isUpdate) {
    if (!data.businessId) throw new ApiError(400, 'businessId is required');
    if (!data[numField] || !String(data[numField]).trim()) throw new ApiError(400, `${label} number is required`);
    if (!data.issueDate) throw new ApiError(400, 'issueDate is required');
    if (!hasLines && !(num(data.amount) > 0)) {
      throw new ApiError(400, `${label} amount must be greater than zero (or provide line items)`);
    }
  }

  // ── Negative-amount guards ───────────────────────────────────────────────
  if (data.amount != null && num(data.amount) < 0) throw new ApiError(400, 'Amount cannot be negative');
  if (data.taxAmount != null && num(data.taxAmount) < 0) throw new ApiError(400, 'Tax amount cannot be negative');
  if (data.shippingCharges != null && num(data.shippingCharges) < 0) throw new ApiError(400, 'Shipping charges cannot be negative');
  if (data.invoiceDiscountValue != null && num(data.invoiceDiscountValue) < 0) throw new ApiError(400, 'Discount cannot be negative');
  if (data.whtAmount != null && num(data.whtAmount) < 0) throw new ApiError(400, 'Withholding amount cannot be negative');

  // ── Currency + FX ────────────────────────────────────────────────────────
  if (data.currencyCode != null && !CURRENCY_RE.test(String(data.currencyCode).toUpperCase())) {
    throw new ApiError(400, 'currencyCode must be a 3-letter ISO code (e.g. USD, PKR, AED)');
  }
  if (data.exchangeRate != null && !(num(data.exchangeRate) > 0)) {
    throw new ApiError(400, 'exchangeRate must be greater than zero');
  }

  // ── Due date ≥ issue date ────────────────────────────────────────────────
  if (data.issueDate && data.dueDate) {
    const issue = new Date(data.issueDate);
    const due = new Date(data.dueDate);
    if (!isNaN(issue) && !isNaN(due) && due < issue) {
      throw new ApiError(400, 'dueDate cannot be earlier than issueDate');
    }
  }

  // ── Line items ───────────────────────────────────────────────────────────
  if (hasLines) {
    data.lineItems.forEach((li, idx) => {
      const n = idx + 1;
      if (!li.name || !String(li.name).trim()) throw new ApiError(400, `Line ${n}: name is required`);
      if (!(num(li.quantity) > 0)) throw new ApiError(400, `Line ${n}: quantity must be greater than zero`);
      if (li.unitPrice == null || num(li.unitPrice) < 0) throw new ApiError(400, `Line ${n}: unit price cannot be negative`);
      if (li.taxRate != null && (num(li.taxRate) < 0 || num(li.taxRate) > 100)) {
        throw new ApiError(400, `Line ${n}: tax rate must be between 0 and 100`);
      }
      if (li.discountValue != null && num(li.discountValue) < 0) throw new ApiError(400, `Line ${n}: discount cannot be negative`);
    });
  }
}

/**
 * Reject a duplicate document number for the business (friendly 409 instead of
 * a raw Mongo E11000). On update, pass excludeId to ignore the document itself.
 * @param {import('mongoose').Model} Model   Invoice or Bill model
 */
async function assertNoDuplicateNumber(Model, businessId, number, numField, excludeId = null) {
  if (!number) return;
  const q = { businessId, [numField]: number, isArchived: { $ne: true } };
  if (excludeId) q._id = { $ne: excludeId };
  const existing = await Model.findOne(q);
  if (existing) {
    const label = numField === 'invoiceNumber' ? 'invoice' : 'bill';
    throw new ApiError(409, `A ${label} with number "${number}" already exists`);
  }
}

/**
 * Ensure a referenced customer/vendor exists for the business.
 * @param {Object} repo  a repository exposing findByBusinessAndId
 */
async function assertPartyExists(repo, businessId, partyId, label) {
  if (!partyId) return;
  const party = await repo.findByBusinessAndId(businessId, partyId);
  if (!party) throw new ApiError(400, `${label} not found for this business`);
}

module.exports = { validateDocumentData, assertNoDuplicateNumber, assertPartyExists, CURRENCY_RE };

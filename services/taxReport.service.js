/**
 * taxReport.service.js — Phase 5.4.6
 *
 * Tax Reporting & Filing Engine.
 *
 * Generates country-specific tax summaries from posted journal entries:
 *  • Tax Ledger: chronological list of all tax transactions
 *  • Tax Summary: input vs output, net payable/recoverable
 *  • WHT Summary: amounts deducted per vendor / category
 *  • Filing Period Summary: data structured for filing returns (GST-101, VAT-201, etc.)
 *
 * All functions are pure aggregations — no DB writes.
 */

'use strict';

const mongoose       = require('mongoose');
const { getProfile } = require('../config/countryTaxProfiles');
const logger         = require('../config/logger');

const JournalEntry   = () => mongoose.model('JournalEntry');

// ─────────────────────────────────────────────────────────────────────────────
//  Tax Ledger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return all journal entries with tax amounts for a period.
 *
 * @param {string} businessId
 * @param {{ startDate: Date, endDate: Date }} period
 * @returns {Promise<object[]>}
 */
async function getTaxLedger(businessId, { startDate, endDate }) {
  const query = {
    businessId,
    status: 'posted',
    taxAmount: { $gt: 0 },
    transactionDate: {},
  };
  if (startDate) query.transactionDate.$gte = startDate;
  if (endDate)   query.transactionDate.$lte = endDate;

  const entries = await JournalEntry()
    .find(query)
    .sort({ transactionDate: 1 })
    .select('transactionDate description amount taxAmount taxRate taxType taxInclusive transactionType')
    .lean();

  return entries.map(e => ({
    date:            e.transactionDate,
    description:     e.description,
    grossAmount:     e.amount,
    taxType:         e.taxType    || 'GST',
    taxRate:         e.taxRate    || 0,
    taxAmount:       e.taxAmount  || 0,
    netAmount:       Math.round((e.amount - (e.taxAmount || 0)) * 100) / 100,
    transactionType: e.transactionType,
    isInclusive:     e.taxInclusive !== false,
    _id:             e._id,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tax Summary (input / output split)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate totals split by input (purchases) and output (sales) tax.
 * Returns net payable = output - input (recoverable).
 *
 * @param {string}  businessId
 * @param {{ startDate: Date, endDate: Date }} period
 * @param {string}  [countryCode]
 * @returns {Promise<TaxSummary>}
 *
 * @typedef {object} TaxSummary
 * @property {number} outputTax       - Tax collected on sales
 * @property {number} inputTax        - Recoverable tax on purchases
 * @property {number} netPayable      - outputTax − inputTax (> 0 = owe, < 0 = refund)
 * @property {object[]} byType        - Breakdown per tax type
 */
async function getTaxSummary(businessId, { startDate, endDate }, countryCode = 'PK') {
  // Output tax: sales types
  const OUTPUT_TYPES = [
    'Cash Sale', 'Credit Sale', 'Inventory Sale',
    'GST Collection', 'VAT Collection',
  ];
  // Input tax: purchase types
  const INPUT_TYPES = [
    'Cash Purchase', 'Credit Purchase', 'Inventory Purchase',
    'GST Payment', 'VAT Payment',
  ];

  const dateFilter = {};
  if (startDate) dateFilter.$gte = startDate;
  if (endDate)   dateFilter.$lte = endDate;

  const [outputEntries, inputEntries] = await Promise.all([
    JournalEntry()
      .find({ businessId, status: 'posted', taxAmount: { $gt: 0 }, transactionType: { $in: OUTPUT_TYPES }, transactionDate: dateFilter })
      .select('taxAmount taxType taxRate')
      .lean(),
    JournalEntry()
      .find({ businessId, status: 'posted', taxAmount: { $gt: 0 }, transactionType: { $in: INPUT_TYPES }, transactionDate: dateFilter })
      .select('taxAmount taxType taxRate')
      .lean(),
  ]);

  const sum    = arr => arr.reduce((s, e) => s + (e.taxAmount || 0), 0);
  const byType = (arr) => {
    const m = {};
    for (const e of arr) {
      const k = e.taxType || 'GST';
      if (!m[k]) m[k] = { taxType: k, count: 0, total: 0 };
      m[k].count++;
      m[k].total = Math.round((m[k].total + (e.taxAmount || 0)) * 100) / 100;
    }
    return Object.values(m);
  };

  const outputTax = Math.round(sum(outputEntries) * 100) / 100;
  const inputTax  = Math.round(sum(inputEntries)  * 100) / 100;

  return {
    outputTax,
    inputTax,
    netPayable:   Math.round((outputTax - inputTax) * 100) / 100,
    outputByType: byType(outputEntries),
    inputByType:  byType(inputEntries),
    period:       { startDate, endDate },
    country:      countryCode,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  WHT Summary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate WHT amounts for the period, grouped by vendor.
 *
 * @param {string} businessId
 * @param {{ startDate: Date, endDate: Date }} period
 * @returns {Promise<object>}
 */
async function getWhtSummary(businessId, { startDate, endDate }) {
  const dateFilter = {};
  if (startDate) dateFilter.$gte = startDate;
  if (endDate)   dateFilter.$lte = endDate;

  const entries = await JournalEntry()
    .find({
      businessId,
      status: 'posted',
      taxAmount: { $gt: 0 },
      taxType: { $regex: /^WHT|^TDS/i },
      transactionDate: dateFilter,
    })
    .populate('vendorId', 'vendorName taxId')
    .select('transactionDate description amount taxAmount taxRate taxType vendorId')
    .lean();

  const byVendor = {};
  for (const e of entries) {
    const vendorName = e.vendorId?.vendorName || 'Unknown Vendor';
    const vendorId   = e.vendorId?._id?.toString() || 'unlinked';
    if (!byVendor[vendorId]) {
      byVendor[vendorId] = {
        vendorId,
        vendorName,
        taxId:       e.vendorId?.taxId || null,
        entries:     [],
        totalWht:    0,
        totalGross:  0,
      };
    }
    byVendor[vendorId].entries.push({
      date:        e.transactionDate,
      description: e.description,
      grossAmount: e.amount,
      whtAmount:   e.taxAmount,
      rate:        e.taxRate,
      taxType:     e.taxType,
    });
    byVendor[vendorId].totalWht   = Math.round((byVendor[vendorId].totalWht   + e.taxAmount) * 100) / 100;
    byVendor[vendorId].totalGross = Math.round((byVendor[vendorId].totalGross + e.amount)    * 100) / 100;
  }

  return {
    vendors:    Object.values(byVendor),
    totalWht:   Object.values(byVendor).reduce((s, v) => s + v.totalWht, 0),
    period:     { startDate, endDate },
    entryCount: entries.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Filing Period Summary (country-specific)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a filing-ready summary for a period.
 * Returns a structured object that matches the local tax return format.
 *
 * Pakistan (GST-101):
 *   Box 1: Output GST on sales
 *   Box 2: Input GST on purchases (recoverable)
 *   Box 3: Net payable / refundable
 *
 * UAE / SA (VAT-201 style):
 *   Standard Rated Sales + Output VAT
 *   Standard Rated Purchases + Input VAT
 *   Net VAT (Payable / Refund)
 *
 * India (GSTR-1 / GSTR-3B):
 *   Outward supplies with CGST/SGST/IGST breakdown
 *   ITC (Input Tax Credit) claimed
 *   Net payable
 *
 * @param {string} businessId
 * @param {{ startDate: Date, endDate: Date }} period
 * @param {string} [country]
 * @returns {Promise<object>} Filing summary
 */
async function getFilingSummary(businessId, { startDate, endDate }, country = 'PK') {
  const summary = await getTaxSummary(businessId, { startDate, endDate }, country);
  const profile = getProfile(country);

  const base = {
    country,
    countryName:      profile.countryName,
    filingPeriod:     { startDate, endDate },
    outputTax:        summary.outputTax,
    inputTax:         summary.inputTax,
    netPayable:       summary.netPayable,
    outputByType:     summary.outputByType,
    inputByType:      summary.inputByType,
    status:           summary.netPayable > 0 ? 'payable' : summary.netPayable < 0 ? 'refundable' : 'nil',
  };

  // Country-specific fields
  if (country === 'PK') {
    return {
      ...base,
      form: 'GST-101 (FBR)',
      boxes: {
        box1_outputGst:    summary.outputTax,
        box2_inputGst:     summary.inputTax,
        box3_netPayable:   summary.netPayable,
      },
    };
  }

  if (country === 'AE' || country === 'SA' || country === 'GB') {
    return {
      ...base,
      form: country === 'AE' ? 'VAT-201 (FTA)' : country === 'SA' ? 'VAT Return (ZATCA)' : 'VAT Return (HMRC)',
      boxes: {
        standardRatedOutputVat: summary.outputTax,
        standardRatedInputVat:  summary.inputTax,
        netVat:                 summary.netPayable,
      },
    };
  }

  if (country === 'IN') {
    const cgst = summary.outputByType.find(t => t.taxType === 'CGST')?.total || 0;
    const sgst = summary.outputByType.find(t => t.taxType === 'SGST')?.total || 0;
    const igst = summary.outputByType.find(t => t.taxType === 'IGST')?.total || 0;
    return {
      ...base,
      form: 'GSTR-3B',
      boxes: {
        outwardSupplies_cgst: cgst,
        outwardSupplies_sgst: sgst,
        outwardSupplies_igst: igst,
        totalOutputTax:       summary.outputTax,
        itc_claimed:          summary.inputTax,
        netPayable:           summary.netPayable,
      },
    };
  }

  // Default
  return { ...base, form: 'Tax Return' };
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  getTaxLedger,
  getTaxSummary,
  getWhtSummary,
  getFilingSummary,
};

/**
 * Accountant Suggestions Service — Phase 3.5 Step 5
 *
 * Pre-save checks that run BEFORE a transaction is committed.
 * Returns warnings/suggestions that the user can review and override.
 * Does NOT block the save — these are advisory signals.
 *
 * Checks:
 *  1. Duplicate invoice number
 *  2. Duplicate transaction (same date + amount + accounts within 24h)
 *  3. Abnormal tax amount (>20% deviation from expected rate)
 *  4. Missing customer on AR transaction
 *  5. Missing vendor on AP transaction
 *  6. Unusually large amount (>3× business average)
 *  7. Future-dated transaction (>7 days ahead)
 *  8. Round-number large amount (potential structuring)
 */

'use strict';

const JournalEntry = require('../models/JournalEntry.model');
const { getTaxRules } = require('../utils/taxRules');
const logger = require('../config/logger');
const mongoose = require('mongoose');

class AccountantSuggestionsService {
  /**
   * Run all pre-save checks for a proposed transaction.
   *
   * @param {string} businessId
   * @param {Object} txData  — the form/API payload (pre-save)
   * @returns {Promise<{ warnings: string[], suggestions: string[], duplicateRisk: boolean }>}
   */
  async preCheck(businessId, txData) {
    const warnings    = [];
    const suggestions = [];
    let duplicateRisk = false;

    const businessObjId = new mongoose.Types.ObjectId(String(businessId));
    const txDate  = txData.transactionDate ? new Date(txData.transactionDate) : new Date();
    const amount  = Number(txData.amount)  || 0;

    await Promise.allSettled([
      this._checkDuplicateInvoice(businessObjId, txData, warnings).catch(() => {}),
      this._checkDuplicateTransaction(businessObjId, txData, txDate, amount, warnings)
        .then(isDup => { if (isDup) duplicateRisk = true; }).catch(() => {}),
      this._checkAbnormalTax(txData, amount, warnings).catch(() => {}),
      this._checkMissingParty(txData, warnings, suggestions).catch(() => {}),
      this._checkUnusualAmount(businessObjId, amount, txDate, warnings).catch(() => {}),
      this._checkFutureDate(txDate, warnings).catch(() => {}),
      this._checkRoundLargeAmount(amount, warnings).catch(() => {}),
    ]);

    return { warnings, suggestions, duplicateRisk };
  }

  async _checkDuplicateInvoice(businessObjId, txData, warnings) {
    const inv = txData.invoiceNumber?.trim();
    if (!inv) return;
    const existing = await JournalEntry.findOne({
      businessId:    businessObjId,
      invoiceNumber: inv,
      isArchived:    { $ne: true },
    }).select('_id transactionDate amount').lean();
    if (existing) {
      warnings.push(
        `Invoice "${inv}" already exists (recorded on ${new Date(existing.transactionDate).toLocaleDateString()}). ` +
        `Verify this is not a duplicate entry.`
      );
    }
  }

  async _checkDuplicateTransaction(businessObjId, txData, txDate, amount, warnings) {
    if (!amount || !txData.debitAccountId || !txData.creditAccountId) return false;
    const windowStart = new Date(txDate.getTime() - 24 * 60 * 60 * 1000);
    const windowEnd   = new Date(txDate.getTime() + 24 * 60 * 60 * 1000);
    const existing = await JournalEntry.findOne({
      businessId:      businessObjId,
      amount,
      debitAccountId:  new mongoose.Types.ObjectId(String(txData.debitAccountId)),
      creditAccountId: new mongoose.Types.ObjectId(String(txData.creditAccountId)),
      transactionDate: { $gte: windowStart, $lte: windowEnd },
      isArchived:      { $ne: true },
    }).select('_id description transactionDate').lean();
    if (existing) {
      warnings.push(
        `A transaction for the same amount (${amount.toLocaleString()}) with the same accounts was recorded ` +
        `on ${new Date(existing.transactionDate).toLocaleDateString()} — possible duplicate.`
      );
      return true;
    }
    return false;
  }

  async _checkAbnormalTax(txData, amount, warnings) {
    const taxAmount = Number(txData.taxAmount) || 0;
    const taxRate   = Number(txData.taxRate)   || 0;
    if (!taxAmount || !amount) return;

    // If both taxRate and taxAmount are provided, check consistency
    if (taxRate > 0) {
      const expected  = Math.round(amount * taxRate / 100 * 100) / 100;
      const deviation = Math.abs(taxAmount - expected) / (expected || 1);
      if (deviation > 0.20) {
        warnings.push(
          `Tax amount (${taxAmount.toLocaleString()}) deviates ${Math.round(deviation * 100)}% from ` +
          `expected ${taxRate}% of ${amount.toLocaleString()} = ${expected.toLocaleString()}. Verify tax calculation.`
        );
      }
    }

    // Sanity: tax > 50% of amount is almost certainly wrong
    if (taxAmount > amount * 0.5) {
      warnings.push(`Tax amount (${taxAmount.toLocaleString()}) exceeds 50% of transaction amount — please verify.`);
    }
  }

  _checkMissingParty(txData, warnings, suggestions) {
    const type         = txData.transactionType || '';
    const customerName = txData.customerName?.trim();
    const vendorName   = txData.vendorName?.trim();

    const AR_TYPES = ['Credit Sale', 'Payment Received', 'Advance from Customer'];
    const AP_TYPES = ['Credit Purchase', 'Payment Made', 'Salary', 'Prepaid Expense'];

    if (AR_TYPES.includes(type) && !customerName) {
      suggestions.push('Consider adding a customer name to track Accounts Receivable accurately.');
    }
    if (AP_TYPES.includes(type) && !vendorName) {
      suggestions.push('Consider adding a vendor name to track Accounts Payable accurately.');
    }
    return Promise.resolve();
  }

  async _checkUnusualAmount(businessObjId, amount, txDate, warnings) {
    if (!amount) return;
    // Compare against 90-day rolling average for this business
    const since = new Date(txDate.getTime() - 90 * 24 * 60 * 60 * 1000);
    const [agg] = await JournalEntry.aggregate([
      { $match: {
        businessId:      businessObjId,
        transactionDate: { $gte: since },
        isArchived:      { $ne: true },
      }},
      { $group: { _id: null, avg: { $avg: '$amount' }, stdDev: { $stdDevPop: '$amount' }, count: { $sum: 1 } } },
    ]);
    if (agg && agg.count >= 10) {
      const threshold = agg.avg + 3 * (agg.stdDev || agg.avg);
      if (amount > threshold) {
        warnings.push(
          `This amount (${amount.toLocaleString()}) is unusually large compared to your recent average ` +
          `(${Math.round(agg.avg).toLocaleString()}). Verify before saving.`
        );
      }
    }
  }

  _checkFutureDate(txDate, warnings) {
    const now     = new Date();
    const sevenDaysAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    if (txDate > sevenDaysAhead) {
      warnings.push(`Transaction date (${txDate.toLocaleDateString()}) is more than 7 days in the future. Confirm this is intentional.`);
    }
    return Promise.resolve();
  }

  _checkRoundLargeAmount(amount, warnings) {
    // Large round amounts divisible by 100,000 — potential structuring flag
    if (amount >= 500000 && amount % 100000 === 0) {
      warnings.push(
        `Large round amount (${amount.toLocaleString()}) — verify this is a genuine transaction and not a test entry.`
      );
    }
    return Promise.resolve();
  }
}

module.exports = new AccountantSuggestionsService();

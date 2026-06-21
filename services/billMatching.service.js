// services/billMatching.service.js
//
// Phase 3.2 — 3-Way Matching Engine
//
// Validates that a vendor Bill reconciles with the Purchase Order (PO) and the
// Goods Receipt Note(s) (GRN) before the payment is released.
//
// Public API:
//   validateQuantityVariance(billed, ordered, received, cfg)
//   validatePriceVariance(billUnitPrice, poUnitPrice, cfg)
//   matchBillToPO(bill, po, cfg)
//   matchBillToGRN(bill, grns, cfg)
//   detectDuplicateVendorInvoice(businessId, vendorId, invoiceNumber, amount, issueDate, excludeBillId)
//   generateMatchStatus(poMatch, grnMatch, duplicateCheck)
//   runFullMatch(billId, businessId, toleranceConfig)
//
'use strict';

const mongoose = require('mongoose');
const Bill         = require('../models/Bill.model');
const PurchaseOrder = require('../models/PurchaseOrder.model');
const GoodsReceipt  = require('../models/GoodsReceipt.model');
const { ApiError }  = require('../utils/ApiError');
const logger        = require('../config/logger');
const {
  THREE_WAY_MATCH_STATUSES: S,
  THREE_WAY_MATCH_TOLERANCE_DEFAULTS: DEFAULTS,
  DUPLICATE_INVOICE_WINDOW_DAYS,
} = require('../config/constants');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const pct = (a, b) => (b === 0 ? 0 : r2(Math.abs(a - b) / b * 100));

/**
 * Merge caller-supplied tolerances over the system defaults.
 * Returns a complete tolerance config object.
 */
function mergeTolerances(cfg = {}) {
  return {
    quantity: { ...DEFAULTS.quantity, ...(cfg.quantity || {}) },
    price:    { ...DEFAULTS.price,    ...(cfg.price    || {}) },
    total:    { ...DEFAULTS.total,    ...(cfg.total    || {}) },
    tax:      { ...DEFAULTS.tax,      ...(cfg.tax      || {}) },
  };
}

/**
 * Categorise a variance percentage against warn/block thresholds.
 * @returns {'ok'|'warn'|'block'}
 */
function varLevel(variancePct, thresholds) {
  if (variancePct <= 0) return 'ok';
  if (variancePct <= thresholds.warn)  return 'ok';   // within acceptable range
  if (variancePct <= thresholds.block) return 'warn';
  return 'block';
}

// ─── Public API ───────────────────────────────────────────────────────────────

class BillMatchingService {

  // ── 1. Quantity variance ────────────────────────────────────────────────────

  /**
   * Check whether a billed quantity is consistent with the ordered / received quantity.
   *
   * @param {number} billedQty    — quantity on the bill line
   * @param {number} orderedQty   — quantity on the matching PO line
   * @param {number} receivedQty  — quantity confirmed in GRN(s) for this PO line
   * @param {object} cfg          — { warn: n, block: n } thresholds (%)
   * @returns {{ level, billedQty, orderedQty, receivedQty, overBilledPct, underReceivedPct, detail }}
   */
  validateQuantityVariance(billedQty, orderedQty, receivedQty, cfg = DEFAULTS.quantity) {
    billedQty   = Number(billedQty)   || 0;
    orderedQty  = Number(orderedQty)  || 0;
    receivedQty = Number(receivedQty) || 0;

    // Guard divide-by-zero (audit A11): when receivedQty is 0 but a positive
    // quantity was billed/ordered, pct() would return 0 and wrongly pass the match —
    // the exact "billed for goods never received" fraud case. Treat it as 100%
    // (definitively over the block threshold).
    const overBilledPct    = billedQty > receivedQty
      ? (receivedQty === 0 ? 100 : pct(billedQty, receivedQty))
      : 0;
    const underReceivedPct = receivedQty < orderedQty
      ? (receivedQty === 0 ? 100 : pct(orderedQty, receivedQty))
      : 0;

    // Worst level wins
    const levelOB = varLevel(overBilledPct, cfg);
    const levelUR = varLevel(underReceivedPct, cfg);
    const level   = levelOB === 'block' || levelUR === 'block' ? 'block'
                  : levelOB === 'warn'  || levelUR === 'warn'  ? 'warn'
                  : 'ok';

    return {
      level,
      billedQty,
      orderedQty,
      receivedQty,
      overBilledPct,
      underReceivedPct,
      detail: level === 'ok'
        ? 'Quantity matches'
        : `Billed ${billedQty} / received ${receivedQty} / ordered ${orderedQty}`,
    };
  }

  // ── 2. Price variance ───────────────────────────────────────────────────────

  /**
   * Compare bill unit price against PO unit price.
   *
   * @param {number} billUnitPrice   — unit price on the bill line
   * @param {number} poUnitPrice     — agreed unit price on the PO line
   * @param {object} cfg             — { warn, block } thresholds (%)
   * @returns {{ level, billUnitPrice, poUnitPrice, variancePct, detail }}
   */
  validatePriceVariance(billUnitPrice, poUnitPrice, cfg = DEFAULTS.price) {
    billUnitPrice = Number(billUnitPrice) || 0;
    poUnitPrice   = Number(poUnitPrice)   || 0;

    const variancePct = pct(billUnitPrice, poUnitPrice);
    const level       = varLevel(variancePct, cfg);

    return {
      level,
      billUnitPrice,
      poUnitPrice,
      variancePct,
      detail: level === 'ok'
        ? 'Price matches'
        : `Bill price ${billUnitPrice} vs PO price ${poUnitPrice} (${variancePct}% variance)`,
    };
  }

  // ── 3. Bill ↔ PO line-item match ────────────────────────────────────────────

  /**
   * Compare bill line items against PO line items using SKU / name matching.
   *
   * Returns a per-line variance report and an overall match status.
   *
   * @param {Object} bill         — Mongoose Bill document (with lineItems)
   * @param {Object} po           — Mongoose PurchaseOrder document (with lineItems)
   * @param {Object} cfg          — merged tolerance config
   * @returns {{ status, lineVariances, overallStatus }}
   */
  matchBillToPO(bill, po, cfg) {
    if (!po) return { status: S.NONE, lineVariances: [], overallStatus: 'no_po' };

    const billLines = Array.isArray(bill.lineItems) ? bill.lineItems : [];
    const poLines   = Array.isArray(po.lineItems)   ? po.lineItems   : [];

    if (billLines.length === 0 || poLines.length === 0) {
      // No line items to compare — fall back to total-only match
      return { status: S.PENDING, lineVariances: [], overallStatus: 'no_lines' };
    }

    const lineVariances = [];
    let worstLevel = 'ok';

    for (const bl of billLines) {
      // Try to find matching PO line by inventory item ID, SKU, or name
      const pl = poLines.find((p) =>
        (bl.inventoryItemId && p.inventoryItemId &&
          bl.inventoryItemId.toString() === p.inventoryItemId.toString()) ||
        (bl.sku && p.sku && bl.sku.trim().toLowerCase() === p.sku.trim().toLowerCase()) ||
        (bl.name && p.name && bl.name.trim().toLowerCase() === p.name.trim().toLowerCase())
      );

      if (!pl) {
        // Bill line has no matching PO line — treat as a mismatch
        lineVariances.push({
          billLineName:  bl.name,
          poLineName:    null,
          matched:       false,
          qtyVariance:   null,
          priceVariance: null,
          detail:        `No matching PO line for bill item "${bl.name}"`,
        });
        worstLevel = 'block';
        continue;
      }

      const qv = this.validateQuantityVariance(
        bl.quantity, pl.quantityOrdered, pl.quantityReceived, cfg.quantity
      );
      const pv = this.validatePriceVariance(bl.unitPrice, pl.unitPrice, cfg.price);

      const lineLevel = qv.level === 'block' || pv.level === 'block' ? 'block'
                      : qv.level === 'warn'  || pv.level === 'warn'  ? 'warn'
                      : 'ok';

      if (lineLevel === 'block' && worstLevel !== 'block') worstLevel = 'block';
      else if (lineLevel === 'warn' && worstLevel === 'ok') worstLevel = 'warn';

      lineVariances.push({
        billLineName:  bl.name,
        poLineName:    pl.name,
        matched:       true,
        qtyVariance:   qv,
        priceVariance: pv,
        lineLevel,
        detail:        lineLevel === 'ok' ? 'OK' : `${qv.detail}; ${pv.detail}`,
      });
    }

    const status = worstLevel === 'block' ? S.BLOCKED
                 : worstLevel === 'warn'  ? S.MISMATCH
                 : S.MATCHED;

    return { status, lineVariances, overallStatus: worstLevel };
  }

  // ── 4. Bill ↔ GRN total match ────────────────────────────────────────────────

  /**
   * Compare the bill's total amount against the sum of GRN received values.
   *
   * @param {Object}   bill  — Mongoose Bill document
   * @param {Object[]} grns  — Array of confirmed GoodsReceipt documents
   * @param {Object}   cfg   — merged tolerance config
   * @returns {{ status, totalBilled, totalReceived, variance, variancePct }}
   */
  matchBillToGRN(bill, grns, cfg) {
    if (!grns || grns.length === 0) {
      return {
        status:        S.NONE,
        totalBilled:   bill.totalAmount || 0,
        totalReceived: 0,
        variance:      bill.totalAmount || 0,
        variancePct:   100,
        detail:        'No GRNs linked to this bill',
      };
    }

    const totalReceived = r2(grns.reduce((s, g) => s + (g.totalReceivedValue || 0), 0));
    const totalBilled   = r2(bill.totalAmount || 0);
    const variance      = r2(Math.abs(totalBilled - totalReceived));
    const variancePct   = pct(totalBilled, totalReceived);

    let level  = varLevel(variancePct, cfg.total);
    let status;

    if (totalBilled > totalReceived) {
      status = level === 'block' ? S.BLOCKED
             : level === 'warn'  ? S.OVER_BILLED
             : S.MATCHED;
    } else if (totalReceived > totalBilled) {
      // Under-billed is generally OK (vendor charged less than delivered)
      status = S.MATCHED;
    } else {
      status = S.MATCHED;
    }

    // Also check whether goods are under-received vs the PO (passed in via grns)
    return { status, totalBilled, totalReceived, variance, variancePct, level, detail:
      level === 'ok'
        ? `GRN total ${totalReceived} matches bill total ${totalBilled}`
        : `GRN total ${totalReceived} vs bill ${totalBilled} (${variancePct}% variance)`,
    };
  }

  // ── 5. Duplicate invoice detection ─────────────────────────────────────────

  /**
   * Detect potential duplicate vendor invoices.
   *
   * A duplicate is another bill for the same vendor with the same
   * vendorReferenceNumber (the vendor's own invoice number), within
   * ±DUPLICATE_INVOICE_WINDOW_DAYS of the issue date, with the same amount
   * (within ±1% to tolerate minor rounding).
   *
   * @param {string}   businessId
   * @param {string}   vendorId
   * @param {string}   vendorReferenceNumber — vendor's invoice number
   * @param {number}   amount
   * @param {Date}     issueDate
   * @param {string}   [excludeBillId]       — bill being matched (exclude self)
   * @returns {Promise<{ isDuplicate, conflictingBillId, conflictingBillNumber }>}
   */
  async detectDuplicateVendorInvoice(
    businessId, vendorId, vendorReferenceNumber, amount, issueDate, excludeBillId = null
  ) {
    if (!vendorReferenceNumber) {
      return { isDuplicate: false, conflictingBillId: null, conflictingBillNumber: null };
    }

    const windowMs  = DUPLICATE_INVOICE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const dateFrom  = new Date(new Date(issueDate).getTime() - windowMs);
    const dateTo    = new Date(new Date(issueDate).getTime() + windowMs);
    const amountLow = r2(amount * 0.99);
    const amountHigh = r2(amount * 1.01);

    const query = {
      businessId,
      vendorId,
      vendorReferenceNumber,
      issueDate:   { $gte: dateFrom, $lte: dateTo },
      totalAmount: { $gte: amountLow, $lte: amountHigh },
      isArchived:  { $ne: true },
      state:       { $nin: ['cancelled'] },
    };
    if (excludeBillId && mongoose.Types.ObjectId.isValid(excludeBillId)) {
      query._id = { $ne: excludeBillId };
    }

    const duplicate = await Bill.findOne(query, { _id: 1, billNumber: 1 }).lean();

    return {
      isDuplicate:           !!duplicate,
      conflictingBillId:     duplicate?._id    ?? null,
      conflictingBillNumber: duplicate?.billNumber ?? null,
    };
  }

  // ── 6. Generate overall match status ───────────────────────────────────────

  /**
   * Resolve the single worst-case match status from all sub-checks.
   *
   * Priority (worst → best):
   *   blocked > over_billed > under_received > mismatch > partial_match > matched
   *
   * A duplicate invoice always escalates to 'blocked'.
   *
   * @param {Object} poMatch        — result from matchBillToPO()
   * @param {Object} grnMatch       — result from matchBillToGRN()
   * @param {Object} duplicateCheck — result from detectDuplicateVendorInvoice()
   * @returns {string}  One of THREE_WAY_MATCH_STATUSES values
   */
  generateMatchStatus(poMatch, grnMatch, duplicateCheck) {
    if (duplicateCheck?.isDuplicate) return S.BLOCKED;

    const statuses = [poMatch?.status, grnMatch?.status].filter(Boolean);

    // Severity order
    const ORDER = [S.BLOCKED, S.OVER_BILLED, S.UNDER_RECEIVED, S.MISMATCH, S.PARTIAL_MATCH, S.MATCHED];

    for (const lvl of ORDER) {
      if (statuses.includes(lvl)) return lvl;
    }

    return S.MATCHED;
  }

  // ── 7. Orchestrate the full match ───────────────────────────────────────────

  /**
   * Run the complete 3-way match for a bill and persist the result.
   *
   * Steps:
   *   1. Load Bill (with line items)
   *   2. If purchaseOrderId set — load PO and run PO line match
   *   3. Load confirmed GRNs — run GRN total match
   *   4. Run duplicate detection (using vendorReferenceNumber)
   *   5. Compute overall status via generateMatchStatus()
   *   6. Persist result to bill.matchResult + bill.threeWayMatchStatus
   *
   * @param {string} billId
   * @param {string} businessId
   * @param {Object} [toleranceCfg]  — partial override of tolerance defaults
   * @returns {Promise<{ status, matchResult, bill }>}
   */
  async runFullMatch(billId, businessId, toleranceCfg = {}) {
    if (!mongoose.Types.ObjectId.isValid(billId)) {
      throw new ApiError(400, 'Invalid bill id');
    }

    const cfg  = mergeTolerances(toleranceCfg);
    const bill = await Bill.findOne({ _id: billId, businessId, isArchived: { $ne: true } });
    if (!bill) throw new ApiError(404, 'Bill not found');

    // No PO → status is 'none' (ad-hoc bill, no match required)
    if (!bill.purchaseOrderId) {
      bill.threeWayMatchStatus = S.NONE;
      bill.matchResult = {
        ranAt: new Date(), toleranceConfig: cfg,
        poMatch: null, grnMatch: null, duplicateCheck: null,
        summary: 'No PO linked — 3-way match not applicable',
      };
      await bill.save();
      return { status: S.NONE, matchResult: bill.matchResult, bill };
    }

    // ── Load PO ──────────────────────────────────────────────────────────────
    let po = null;
    try {
      po = await PurchaseOrder.findOne({ _id: bill.purchaseOrderId, businessId });
    } catch (e) {
      logger.warn(`[billMatch] could not load PO ${bill.purchaseOrderId}: ${e.message}`);
    }

    // ── Load confirmed GRNs ──────────────────────────────────────────────────
    const grnIds = Array.isArray(bill.linkedGrnIds) ? bill.linkedGrnIds : [];
    let grns = [];
    if (grnIds.length > 0) {
      grns = await GoodsReceipt.find({
        _id:   { $in: grnIds },
        businessId,
        state: { $nin: ['cancelled'] },
      }).lean();
    }

    // ── Run sub-checks ───────────────────────────────────────────────────────
    const poMatch = this.matchBillToPO(bill, po, cfg);

    const grnMatch = this.matchBillToGRN(bill, grns, cfg);

    const duplicateCheck = await this.detectDuplicateVendorInvoice(
      businessId,
      bill.vendorId,
      bill.vendorReferenceNumber,
      bill.totalAmount,
      bill.issueDate,
      bill._id.toString()
    );

    // ── Under-received check (PO qty vs GRN qty) ─────────────────────────────
    let underReceivedStatus = S.MATCHED;
    if (po) {
      const totalOrdered  = po.lineItems.reduce((s, li) => s + (li.quantityOrdered || 0), 0);
      const totalReceived = po.lineItems.reduce((s, li) => s + (li.quantityReceived || 0), 0);
      const urPct         = pct(totalOrdered, Math.max(totalReceived, 0.001));
      if (urPct > cfg.quantity.block) underReceivedStatus = S.BLOCKED;
      else if (urPct > cfg.quantity.warn) underReceivedStatus = S.UNDER_RECEIVED;
    }

    // Override grnMatch status if under-received is worse
    const grnMatchFinal = {
      ...grnMatch,
      status: [S.BLOCKED, S.OVER_BILLED, S.UNDER_RECEIVED].includes(underReceivedStatus)
              && underReceivedStatus !== S.MATCHED
        ? underReceivedStatus
        : grnMatch.status,
    };

    // ── Overall status ────────────────────────────────────────────────────────
    const overall = this.generateMatchStatus(poMatch, grnMatchFinal, duplicateCheck);

    // ── Build summary string ──────────────────────────────────────────────────
    const summaryParts = [];
    if (duplicateCheck.isDuplicate) summaryParts.push(`DUPLICATE of bill ${duplicateCheck.conflictingBillNumber}`);
    if (poMatch.status !== S.MATCHED && poMatch.status !== S.NONE) summaryParts.push(`PO: ${poMatch.status}`);
    if (grnMatchFinal.status !== S.MATCHED && grnMatchFinal.status !== S.NONE) summaryParts.push(`GRN: ${grnMatchFinal.status}`);
    const summary = summaryParts.length > 0 ? summaryParts.join(' | ') : 'All checks passed';

    // ── Persist ───────────────────────────────────────────────────────────────
    bill.threeWayMatchStatus = overall;
    bill.matchResult = {
      ranAt:           new Date(),
      toleranceConfig: cfg,
      poMatch,
      grnMatch:        grnMatchFinal,
      duplicateCheck,
      summary,
    };

    await bill.save();
    logger.info(`[billMatch] Bill ${bill.billNumber} match result: ${overall} — ${summary}`);

    return { status: overall, matchResult: bill.matchResult, bill };
  }
}

module.exports = new BillMatchingService();

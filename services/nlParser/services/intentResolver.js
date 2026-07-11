// services/nlParser/services/intentResolver.js
//
// Deterministic, DB-free "why was this bought?" resolver. The AI supplies
// signals (lineItems, purchaseIntent); THIS module decides — using the live
// item catalog and the user's own words — and says when the one plain
// clarifying question is genuinely needed. Decision table lives in the spec:
// docs/superpowers/specs/2026-07-11-smart-transaction-entry-design.md §2.
'use strict';
const { matchItemByName } = require('../../../utils/itemMatcher');
const { detectAnswers } = require('../constants/clarificationAnswers');

const PURCHASE_FAMILY = new Set(['expense', 'inventory_purchase', 'asset_purchase', 'gst_exclusive_purchase']);
const SALE_FAMILY = new Set(['income', 'inventory_sale', 'gst_inclusive_sale', 'gst_exclusive_sale']);
const INTENT_TO_TYPE = Object.freeze({
  resale: 'inventory_purchase',
  business_use: 'expense',
  long_term_asset: 'asset_purchase',
});

const RESALE_CUES = /\b(for sale|to sell|resale|resell|stock|inventory|maal)\b/i;
const ITEM_MATCH_MIN_CONFIDENCE = 0.75; // exact or single-substring fuzzy only

/**
 * @param {object} normalized  output of normalizeExtraction (needs transactionType,
 *                             lineItems, purchaseIntent, saleAffectsStock)
 * @param {{rawText?: string, inventoryItems?: Array}} ctx
 * @returns {{ classification: string|null, matchedItem: object|null, itemConsent: boolean|null,
 *             needsClassificationQuestion: boolean, needsItemConsent: boolean, needsQuantity: boolean }}
 */
function resolveIntent(normalized, { rawText = '', inventoryItems = [] } = {}) {
  const answers = detectAnswers(rawText);
  const lineItems = normalized.lineItems || [];
  const primaryItem = lineItems[0] || null;
  const isPurchase = PURCHASE_FAMILY.has(normalized.transactionType);
  const isSale = SALE_FAMILY.has(normalized.transactionType);

  const result = {
    classification: null,
    matchedItem: null,
    itemConsent: answers.itemConsent,
    needsClassificationQuestion: false,
    needsItemConsent: false,
    needsQuantity: false,
  };
  if (!isPurchase && !isSale) return result;

  if (primaryItem) {
    const m = matchItemByName(inventoryItems, primaryItem.name);
    if (m.item && m.confidence >= ITEM_MATCH_MIN_CONFIDENCE) result.matchedItem = m;
  }

  if (isSale) {
    // Only a matched item can actually move stock — an unmatched "sale of
    // goods" records revenue only (you can't decrement stock you never tracked).
    if (result.matchedItem) {
      result.classification = 'sale_of_stock';
      if (!(primaryItem?.quantity > 0)) result.needsQuantity = true;
    }
    return result;
  }

  // ── Purchases: decision table, first match wins ──────────────────────────
  if (answers.intentAnswer) {
    result.classification = answers.intentAnswer;             // user's answer beats everything
  } else if (result.matchedItem) {
    result.classification = 'resale';                          // row 1
  } else if (RESALE_CUES.test(rawText)) {
    result.classification = 'resale';                          // row 2
  } else if (normalized.purchaseIntent === 'long_term_asset' || normalized.transactionType === 'asset_purchase') {
    result.classification = 'long_term_asset';                 // row 3
  } else if (inventoryItems.length === 0) {
    result.classification = 'business_use';                    // row 4
  } else if (primaryItem && !normalized.purchaseIntent) {
    result.needsClassificationQuestion = true;                 // row 5 — genuinely torn
  } else {
    result.classification = normalized.purchaseIntent || 'business_use'; // row 6
  }

  // ── Resale follow-ups: consent-first item creation, then quantity ────────
  if (result.classification === 'resale') {
    if (!result.matchedItem && primaryItem && result.itemConsent === null) {
      result.needsItemConsent = true;
    }
    const stockWillMove = result.matchedItem || result.itemConsent === true;
    if (stockWillMove && !(primaryItem?.quantity > 0)) {
      result.needsQuantity = true;
    }
  }
  return result;
}

/**
 * Shape the preview's inventory block from a finished resolution.
 * mode 'create' requires explicit prior consent — ask-first, never silent.
 */
function buildInventoryBlock(normalized, r) {
  const li = (normalized.lineItems || [])[0] || null;
  const quantity = li?.quantity || null;
  if (r.classification === 'sale_of_stock' || (r.classification === 'resale' && r.matchedItem)) {
    if (!r.matchedItem) return { mode: 'none' };
    return {
      mode: 'existing',
      itemId: String(r.matchedItem.item._id),
      itemName: r.matchedItem.item.name,
      quantity,
      unit: li?.unit || r.matchedItem.item.unit || 'units',
      unitCostPrice: li?.unitPrice ?? r.matchedItem.item.unitCostPrice ?? null,
      currentStock: r.matchedItem.item.currentStock ?? null,
    };
  }
  if (r.classification === 'resale' && r.itemConsent === true && li) {
    return {
      mode: 'create',
      itemName: li.name,
      quantity,
      unit: li.unit || 'units',
      unitCostPrice: li.unitPrice ?? null,
    };
  }
  return { mode: 'none' };
}

module.exports = { resolveIntent, buildInventoryBlock, PURCHASE_FAMILY, SALE_FAMILY, INTENT_TO_TYPE };

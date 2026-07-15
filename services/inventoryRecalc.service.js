// services/inventoryRecalc.service.js
//
// R-04 — Inventory cost recalculation ("rewind & replay").
//
// Weighted-average cost (WAC) is maintained incrementally on the item, so a
// change to a HISTORICAL movement (e.g. a goods-receipt voided or its cost
// corrected after later sales were already booked) leaves the item's stored
// WAC / on-hand quantity — and therefore its inventory valuation — drifted from
// reality. There is no per-item movement table, but every stock movement leaves
// a journal entry tagged with inventoryItemId + inventoryQty, so we can replay
// those in date order to recompute the CORRECT quantity and WAC, surface the
// drift, and (optionally) heal it by:
//   • resetting the item's currentStock + unitCostPrice to the replayed values, and
//   • posting ONE balanced Inventory↔COGS adjustment journal for the value delta,
// all inside a single transaction.
//
'use strict';

const mongoose = require('mongoose');
const InventoryItem = require('../models/InventoryItem.model');
const JournalEntry = require('../models/JournalEntry.model');
const inventoryService = require('./inventory.service'); // resolveCostAccounts
const { postBalancedJournal } = require('./ledgerPosting.service');
const { withTransaction } = require('../utils/withTransaction');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const {
  TRANSACTION_TYPES, TRANSACTION_SOURCES, JOURNAL_STATUS, INPUT_METHODS,
} = require('../config/constants');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const PURCHASE_TYPES = new Set([
  TRANSACTION_TYPES.INVENTORY_PURCHASE,
  TRANSACTION_TYPES.CASH_PURCHASE,
  TRANSACTION_TYPES.CREDIT_PURCHASE,
]);
const SALE_TYPES = new Set([
  TRANSACTION_TYPES.INVENTORY_SALE,
  TRANSACTION_TYPES.CASH_SALE,
  TRANSACTION_TYPES.CREDIT_SALE,
  TRANSACTION_TYPES.INCOME,
]);

class InventoryRecalcService {
  /**
   * Replay an item's stock movements (from the journal) to recompute the correct
   * on-hand quantity and unit cost. Pure read — no writes.
   *
   * INV-4 — method-aware: `method: 'fifo'` replays purchases as cost layers and
   * consumes sales oldest-first (same `consumeFifo` the live path uses), so a
   * heal can also rebuild `costLayers`. Default stays weighted-average.
   *
   * @returns {Promise<{correctQty:number, correctWac:number, correctValue:number,
   *                     replayedCogs:number, movementCount:number, correctLayers:(Array|null)}>}
   */
  async replayItem(businessId, itemId, method = 'weighted_average') {
    const entries = await JournalEntry.find({
      businessId: new mongoose.Types.ObjectId(String(businessId)),
      inventoryItemId: new mongoose.Types.ObjectId(String(itemId)),
      status: JOURNAL_STATUS.POSTED,
      isArchived: { $ne: true },
    })
      .sort({ transactionDate: 1, createdAt: 1 })
      .select('transactionType inventoryQty amount transactionDate')
      .lean();

    const isFifo = method === 'fifo';
    const { consumeFifo } = require('../utils/inventoryCosting.util');

    let qty = 0;        // running on-hand quantity
    let wac = 0;        // running weighted-average unit cost (summary for fifo)
    let cogs = 0;       // cumulative cost of goods sold (replayed)
    let layers = [];    // fifo cost layers (oldest first)

    for (const e of entries) {
      const moveQty = Number(e.inventoryQty) || 0;
      if (moveQty <= 0) continue;

      if (PURCHASE_TYPES.has(e.transactionType)) {
        // Inflow: unit cost = entry amount / qty (fallback to current WAC).
        const unitCost = e.amount > 0 ? (Number(e.amount) / moveQty) : wac;
        const newQty = qty + moveQty;
        wac = newQty > 0 ? (qty * wac + moveQty * unitCost) / newQty : unitCost;
        qty = newQty;
        if (isFifo) layers.push({ qty: moveQty, unitCost: r2(unitCost) });
      } else if (SALE_TYPES.has(e.transactionType)) {
        // Outflow (can't go below zero).
        const out = Math.min(moveQty, qty);
        if (isFifo) {
          const res = consumeFifo(layers, out);
          layers = res.remainingLayers;
          cogs += res.cogsAmount;
        } else {
          cogs += out * wac;
        }
        qty -= out;
      }
    }

    const layerValue = isFifo ? layers.reduce((s, l) => s + l.qty * l.unitCost, 0) : null;
    const correctValue = isFifo ? r2(layerValue) : r2(qty * wac);
    const correctWac = isFifo ? (qty > 0 ? r2(layerValue / qty) : r2(wac)) : r2(wac);

    return {
      correctQty:    r2(qty),
      correctWac,
      correctValue,
      replayedCogs:  r2(cogs),
      movementCount: entries.length,
      correctLayers: isFifo ? layers : null,
    };
  }

  /**
   * Recompute an item's valuation and (optionally) heal any drift.
   *
   * @param {string} businessId
   * @param {string} itemId
   * @param {Object} [opts]
   * @param {boolean} [opts.post=false]  when true, correct the item + post the adjustment JE
   * @param {Object}  [opts.user]        actor for the adjustment JE
   * @returns {Promise<Object>} a drift report (+ adjustmentJournalId when posted)
   */
  async recalculateItem(businessId, itemId, { post = false, user = null } = {}) {
    if (!mongoose.Types.ObjectId.isValid(itemId)) throw new ApiError(400, 'Invalid inventory item id');
    const item = await InventoryItem.findOne({ _id: itemId, businessId });
    if (!item) throw new ApiError(404, 'Inventory item not found');

    const replay = await this.replayItem(businessId, itemId, item.valuationMethod || 'weighted_average');
    const storedValue = r2(item.currentStock * item.unitCostPrice);
    const valueVariance = r2(replay.correctValue - storedValue);
    const qtyVariance = r2(replay.correctQty - item.currentStock);
    const inSync = Math.abs(valueVariance) < 0.01 && Math.abs(qtyVariance) < 0.0001;

    const report = {
      itemId: String(item._id),
      name: item.name,
      stored:  { qty: item.currentStock, wac: item.unitCostPrice, value: storedValue },
      correct: { qty: replay.correctQty, wac: replay.correctWac, value: replay.correctValue },
      valueVariance,
      qtyVariance,
      replayedCogs: replay.replayedCogs,
      movementCount: replay.movementCount,
      inSync,
      applied: false,
      adjustmentJournalId: null,
    };

    if (!post || inSync) return report;

    // Heal: reset stored qty/WAC and book the value delta as one balanced entry.
    const { cogsAccountId, inventoryAccountId } = await inventoryService.resolveCostAccounts(businessId);

    await withTransaction(async (session) => {
      item.currentStock  = replay.correctQty;
      item.unitCostPrice = replay.correctWac;
      // INV-4 — a FIFO item's layers must be healed together with qty/WAC,
      // otherwise Σ(layers.qty) ≠ currentStock and the next sale mis-costs.
      if (item.valuationMethod === 'fifo' && replay.correctLayers) {
        item.costLayers = replay.correctLayers;
      }
      await item.save({ session });

      const delta = valueVariance;
      if (Math.abs(delta) >= 0.01 && inventoryAccountId && cogsAccountId) {
        // delta > 0 → inventory is worth MORE than booked: DR Inventory, CR COGS.
        // delta < 0 → inventory worth LESS: DR COGS, CR Inventory.
        const debitAccountId  = delta > 0 ? inventoryAccountId : cogsAccountId;
        const creditAccountId = delta > 0 ? cogsAccountId : inventoryAccountId;
        const je = await postBalancedJournal({
          businessId,
          transactionDate:   new Date(),
          description:       `Inventory valuation adjustment — ${item.name} (recalculation)`,
          // Repeatable on purpose: a recalculation is a heal, and re-running it
          // after new movements must be able to post a fresh correction.
          idempotencyKey: null,
          transactionType:   TRANSACTION_TYPES.JOURNAL_ENTRY,
          amount:            Math.abs(delta),
          debitAccountId,
          creditAccountId,
          status:            JOURNAL_STATUS.POSTED,
          transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
          inputMethod:       INPUT_METHODS.FORM,
          inventoryItemId:   item._id,
          createdBy:         user?._id || item.businessId, // fall back to a non-null id
          lastModifiedBy:    user?._id || null,
        }, { session });
        report.adjustmentJournalId = je._id;
      }
      report.applied = true;
    });

    logger.warn(`[inventoryRecalc] item ${itemId} healed: qty ${report.stored.qty}→${report.correct.qty}, wac ${report.stored.wac}→${report.correct.wac}, value delta ${valueVariance}`);
    return report;
  }
}

module.exports = new InventoryRecalcService();

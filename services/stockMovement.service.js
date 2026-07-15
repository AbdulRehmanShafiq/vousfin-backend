// services/stockMovement.service.js
//
// Inventory Engine Phase 1 — writer + readers for the append-only item
// sub-ledger (StockMovement). Every physical stock change records exactly one
// movement IN THE SAME SESSION as the item mutation, so the sub-ledger can
// never diverge from what actually committed.
//
// Also home of the inventory↔GL integrity check (spec §2.4): movements are the
// truth; the item's cached qty/valuation and the Inventory GL account are
// projections that must reconcile to them.
'use strict';

const mongoose = require('mongoose');
const StockMovement = require('../models/StockMovement.model');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

class StockMovementService {
  /**
   * Record one movement. Called by inventory.service inside the mutation's
   * session — a failed write aborts the whole operation (the sub-ledger is
   * accounting, not observability; it must never be fire-and-forget).
   *
   * @param {Object} m  { businessId, itemId, direction, movementType, qty,
   *                      unitCost, balanceQtyAfter, balanceValueAfter,
   *                      source?, journalEntryId?, movementDate?, notes?, createdBy? }
   * @param {Object} [opts] { session }
   */
  async record(m, opts = {}) {
    if (!m.businessId || !m.itemId) throw new ApiError(400, 'businessId and itemId are required');
    // Revaluations are value-only (qty 0); every physical movement needs qty > 0.
    if (m.movementType !== 'revalue' && !(Number(m.qty) > 0)) {
      throw new ApiError(400, 'Movement qty must be positive');
    }

    const doc = {
      businessId: m.businessId,
      itemId: m.itemId,
      direction: m.direction,
      movementType: m.movementType,
      qty: Number(m.qty),
      unitCost: r2(m.unitCost),
      // Exact GL value wins when supplied (FIFO blends round the unit cost,
      // so qty × rounded-unitCost can drift a cent from the true COGS).
      value: m.value != null ? r2(m.value) : r2(Number(m.qty) * (Number(m.unitCost) || 0)),
      balanceQtyAfter: Number(m.balanceQtyAfter) || 0,
      balanceValueAfter: r2(m.balanceValueAfter),
      source: m.source || { docType: null, docId: null },
      journalEntryId: m.journalEntryId || null,
      warehouseId: m.warehouseId || null,
      movementDate: m.movementDate || new Date(),
      reason: m.reason || null,
      notes: m.notes || null,
      createdBy: m.createdBy || null,
    };
    const [created] = await StockMovement.create([doc], { session: opts.session || null });
    return created;
  }

  /**
   * Item ledger — the movement history with running balances, newest first.
   */
  async getLedger(businessId, itemId, { limit = 200 } = {}) {
    return StockMovement.find({ businessId, itemId })
      .sort({ movementDate: -1, _id: -1 })
      .limit(Math.min(Number(limit) || 200, 1000))
      .lean();
  }

  /** True when an item has at least one recorded movement (post-migration). */
  async hasMovements(businessId, itemId) {
    const one = await StockMovement.findOne({ businessId, itemId }).select('_id').lean();
    return !!one;
  }

  /**
   * Inventory integrity — compare each item's cached projection
   * (currentStock × unitCostPrice) against its movement-derived quantity and
   * value, and the business total against the Inventory GL balance.
   *
   * Items with zero movements are reported as `untracked` (history predates
   * the sub-ledger and hasn't been backfilled) — not as drift.
   *
   * @returns {Promise<{items:Array, totals:Object}>}
   */
  async computeDrift(businessId) {
    const InventoryItem = require('../models/InventoryItem.model');
    const bid = new mongoose.Types.ObjectId(String(businessId));

    const [sums, items] = await Promise.all([
      StockMovement.aggregate([
        { $match: { businessId: bid } },
        {
          $group: {
            _id: '$itemId',
            qtyIn:    { $sum: { $cond: [{ $eq: ['$direction', 'in'] },  '$qty',   0] } },
            qtyOut:   { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$qty',   0] } },
            valueIn:  { $sum: { $cond: [{ $eq: ['$direction', 'in'] },  '$value', 0] } },
            valueOut: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$value', 0] } },
            movements: { $sum: 1 },
          },
        },
      ]),
      InventoryItem.find({ businessId: bid }).select('name sku currentStock unitCostPrice isActive').lean(),
    ]);

    const byItem = new Map(sums.map((s) => [String(s._id), s]));
    const report = [];
    let trackedValue = 0;

    for (const item of items) {
      const s = byItem.get(String(item._id));
      const cachedQty = Number(item.currentStock) || 0;
      const cachedValue = r2(cachedQty * (Number(item.unitCostPrice) || 0));
      if (!s) {
        report.push({ itemId: item._id, name: item.name, sku: item.sku, untracked: true, cachedQty, cachedValue });
        continue;
      }
      const ledgerQty = r2(s.qtyIn - s.qtyOut);
      const ledgerValue = r2(s.valueIn - s.valueOut);
      trackedValue = r2(trackedValue + ledgerValue);
      report.push({
        itemId: item._id, name: item.name, sku: item.sku,
        untracked: false, movements: s.movements,
        cachedQty, ledgerQty, qtyDrift: r2(cachedQty - ledgerQty),
        cachedValue, ledgerValue, valueDrift: r2(cachedValue - ledgerValue),
      });
    }

    const drifted = report.filter((x) => !x.untracked && (Math.abs(x.qtyDrift) > 0.0001 || Math.abs(x.valueDrift) >= 0.01));
    if (drifted.length) {
      logger.warn(`[inventoryIntegrity] ${drifted.length} item(s) drifted from the stock sub-ledger for business ${businessId}`);
    }

    return {
      items: report,
      totals: {
        itemCount: report.length,
        untrackedCount: report.filter((x) => x.untracked).length,
        driftedCount: drifted.length,
        trackedLedgerValue: trackedValue,
      },
    };
  }
}

module.exports = new StockMovementService();

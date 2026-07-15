// services/warehouse.service.js
//
// Inventory Engine Phase 5 — locations and transfers.
//
// Moving stock between your own locations changes WHERE it is, not WHAT it is
// worth: the goods never leave the business, so no revenue, no cost, no
// journal. Value is conserved exactly — the transfer out and the transfer in
// carry the identical cost — so the Inventory account is untouched by design.
//
// The only exception is in-transit tracking (goods on a truck between sites),
// which parks value in Stock in Transit (1158) between dispatch and arrival.
'use strict';

const mongoose = require('mongoose');
const Warehouse = require('../models/Warehouse.model');
const InventoryItem = require('../models/InventoryItem.model');
const stockMovementService = require('./stockMovement.service');
const { withTransaction } = require('../utils/withTransaction');
const { quoteConsumption, r2 } = require('../utils/inventoryCosting.util');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');

const actorId = (user) => user?._id || user?.id || null;

class WarehouseService {
  async create(businessId, data, user) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');
    if (!data?.name?.trim()) throw new ApiError(400, 'Give this location a name');

    if (data.code?.trim()) {
      const clash = await Warehouse.findOne({ businessId, code: data.code.trim().toUpperCase() }).lean();
      if (clash) throw new ApiError(409, `Another location already uses the code "${data.code.trim().toUpperCase()}"`);
    }
    // Exactly one default per tenant.
    const isFirst = (await Warehouse.countDocuments({ businessId })) === 0;
    const makeDefault = data.isDefault || isFirst;
    if (makeDefault) await Warehouse.updateMany({ businessId }, { $set: { isDefault: false } });

    return Warehouse.create({
      businessId,
      name: data.name.trim(),
      code: data.code?.trim()?.toUpperCase() || null,
      address: data.address || null,
      notes: data.notes || null,
      isDefault: makeDefault,
      createdBy: actorId(user),
    });
  }

  async list(businessId, { includeInactive = false } = {}) {
    const q = { businessId };
    if (!includeInactive) q.isActive = true;
    return Warehouse.find(q).sort({ isDefault: -1, name: 1 }).lean();
  }

  async update(businessId, id, data) {
    const wh = await Warehouse.findOne({ _id: id, businessId });
    if (!wh) throw new ApiError(404, 'Location not found');
    if (data.isDefault === true) {
      await Warehouse.updateMany({ businessId }, { $set: { isDefault: false } });
      wh.isDefault = true;
    }
    for (const f of ['name', 'address', 'notes', 'isActive']) {
      if (data[f] !== undefined) wh[f] = data[f];
    }
    if (data.code !== undefined) wh.code = data.code?.trim()?.toUpperCase() || null;
    await wh.save();
    return wh;
  }

  /** Per-location stock for one item (or the whole business), derived from movements. */
  async stockByLocation(businessId, itemId = null) {
    const [balances, warehouses] = await Promise.all([
      stockMovementService.balancesByWarehouse(businessId, itemId),
      Warehouse.find({ businessId }).select('name code').lean(),
    ]);
    const byId = new Map(warehouses.map((w) => [String(w._id), w]));
    return balances
      .filter((b) => Math.abs(b.qty) > 0.0001 || Math.abs(b.value) >= 0.01)
      .map((b) => ({
        ...b,
        warehouseName: b.warehouseId ? (byId.get(String(b.warehouseId))?.name || 'Unknown location') : 'Unassigned',
      }));
  }

  /**
   * Move stock between two locations. No journal: value is conserved and the
   * goods never left the business.
   *
   * @param {Object} p { itemId, fromWarehouseId, toWarehouseId, qty, notes?, date? }
   */
  async transfer(businessId, p = {}, user) {
    const qty = Number(p.qty);
    if (!(qty > 0)) throw new ApiError(400, 'How many units are you moving?');
    if (!p.fromWarehouseId || !p.toWarehouseId) throw new ApiError(400, 'Choose where the stock is moving from and to');
    if (String(p.fromWarehouseId) === String(p.toWarehouseId)) {
      throw new ApiError(400, 'Pick two different locations — this one is the same on both sides');
    }
    if (!mongoose.Types.ObjectId.isValid(String(p.itemId))) throw new ApiError(400, 'Invalid inventory item id');

    const [from, to] = await Promise.all([
      Warehouse.findOne({ _id: p.fromWarehouseId, businessId }).lean(),
      Warehouse.findOne({ _id: p.toWarehouseId, businessId }).lean(),
    ]);
    if (!from || !to) throw new ApiError(404, 'One of those locations does not exist');

    let result = null;
    const when = p.date ? new Date(p.date) : new Date();

    await withTransaction(async (s) => {
      const item = await InventoryItem.findOne({ _id: p.itemId, businessId }).session(s);
      if (!item) throw new ApiError(404, 'Inventory item not found');

      // You can only move what is actually at the source location.
      const balances = await stockMovementService.balancesByWarehouse(businessId, p.itemId);
      const atSource = balances.find((b) => String(b.warehouseId) === String(p.fromWarehouseId));
      const available = atSource ? atSource.qty : 0;
      if (qty > available + 0.0001) {
        throw new ApiError(400, `${from.name} only has ${available} ${item.unit || 'units'} of "${item.name}" — you cannot move ${qty}.`);
      }

      // Both legs carry the SAME cost, so total value is unchanged.
      const unitCost = quoteConsumption(item, qty).unitCostUsed || item.unitCostPrice || 0;
      const value = r2(qty * unitCost);
      const totalValue = r2(item.currentStock * item.unitCostPrice);
      const common = {
        businessId, itemId: item._id, qty, unitCost, value,
        balanceQtyAfter: item.currentStock,      // item total never changes
        balanceValueAfter: totalValue,
        source: { docType: 'StockTransfer', docId: null },
        journalEntryId: null,                    // no accounting effect, by design
        movementDate: when, createdBy: actorId(user),
        notes: p.notes || `Moved from ${from.name} to ${to.name}`,
      };
      await stockMovementService.record(
        { ...common, direction: 'out', movementType: 'transfer_out', warehouseId: from._id }, { session: s });
      await stockMovementService.record(
        { ...common, direction: 'in', movementType: 'transfer_in', warehouseId: to._id }, { session: s });

      result = {
        itemId: item._id, name: item.name, qty, unitCost, value,
        from: { _id: from._id, name: from.name }, to: { _id: to._id, name: to.name },
      };
    });

    logger.info(`[warehouse] moved ${qty} of ${p.itemId}: ${from.name} → ${to.name} (value ${result.value} unchanged)`);
    return result;
  }
}

module.exports = new WarehouseService();

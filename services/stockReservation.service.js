// services/stockReservation.service.js
//
// Inventory Engine Phase 6 — reservations, available-to-promise, backorders.
//
// NOTHING here touches the ledger. Promising stock to a customer is not an
// accounting event: the goods are still yours, still on the shelf, still in
// Inventory at cost. Only shipping moves stock and recognises COGS — which is
// why `fulfil()` hands off to the existing sale path rather than inventing one.
//
//   Available to promise = on hand − promised to someone else
'use strict';

const mongoose = require('mongoose');
const StockReservation = require('../models/StockReservation.model');
const InventoryItem = require('../models/InventoryItem.model');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const actorId = (user) => user?._id || user?.id || null;

class StockReservationService {
  /** Units currently promised to someone else. */
  async reservedQty(businessId, itemId, { excludeDocId = null } = {}) {
    const match = {
      businessId: new mongoose.Types.ObjectId(String(businessId)),
      itemId: new mongoose.Types.ObjectId(String(itemId)),
      state: 'active',
    };
    if (excludeDocId) match['source.docId'] = { $ne: new mongoose.Types.ObjectId(String(excludeDocId)) };
    const [row] = await StockReservation.aggregate([
      { $match: match },
      { $group: { _id: null, qty: { $sum: '$qty' } } },
    ]);
    return r2(row?.qty || 0);
  }

  /**
   * What can actually be sold today.
   * @returns {Promise<{ onHand, reserved, available, backordered }>}
   */
  async availableToPromise(businessId, itemId) {
    const item = await InventoryItem.findOne({ _id: itemId, businessId }).select('currentStock name unit').lean();
    if (!item) throw new ApiError(404, 'Inventory item not found');
    const [reserved, backRow] = await Promise.all([
      this.reservedQty(businessId, itemId),
      StockReservation.aggregate([
        { $match: {
          businessId: new mongoose.Types.ObjectId(String(businessId)),
          itemId: new mongoose.Types.ObjectId(String(itemId)),
          state: 'backordered',
        } },
        { $group: { _id: null, qty: { $sum: '$qty' } } },
      ]),
    ]);
    const onHand = r2(item.currentStock);
    return {
      itemId, name: item.name, unit: item.unit,
      onHand, reserved,
      available: r2(onHand - reserved),
      backordered: r2(backRow[0]?.qty || 0),
    };
  }

  /**
   * Promise stock to a document. Reserves what it can; the shortfall becomes a
   * backorder rather than an error, so the sale is never silently lost.
   *
   * @param {Object} p { itemId, qty, source:{docType,docId}, warehouseId?, expectedDate?, allowBackorder? }
   * @returns {Promise<{ reserved, backordered, available }>}
   */
  async reserve(businessId, p = {}, user) {
    const qty = Number(p.qty);
    if (!(qty > 0)) throw new ApiError(400, 'How many units do you want to set aside?');
    const atp = await this.availableToPromise(businessId, p.itemId);

    const canReserve = Math.max(0, Math.min(qty, atp.available));
    const shortfall = r2(qty - canReserve);
    if (shortfall > 0 && p.allowBackorder === false) {
      throw new ApiError(400,
        `Only ${atp.available} ${atp.unit || 'units'} of "${atp.name}" are free to promise — the rest is already promised to someone else.`);
    }

    const made = [];
    if (canReserve > 0) {
      made.push(await StockReservation.create({
        businessId, itemId: p.itemId, qty: canReserve, state: 'active',
        warehouseId: p.warehouseId || null,
        source: p.source || { docType: null, docId: null },
        expectedDate: p.expectedDate || null,
        createdBy: actorId(user),
      }));
    }
    if (shortfall > 0) {
      made.push(await StockReservation.create({
        businessId, itemId: p.itemId, qty: shortfall, state: 'backordered',
        warehouseId: p.warehouseId || null,
        source: p.source || { docType: null, docId: null },
        expectedDate: p.expectedDate || null,
        notes: 'Waiting on stock',
        createdBy: actorId(user),
      }));
    }

    logger.info(`[reservation] item ${p.itemId}: reserved ${canReserve}, backordered ${shortfall}`);
    return {
      reserved: canReserve,
      backordered: shortfall,
      available: r2(atp.available - canReserve),
      reservations: made,
    };
  }

  /** Give the stock back to the pool (order cancelled / draft deleted). */
  async release(businessId, { docType, docId, itemId = null }, user) {
    const q = { businessId, state: { $in: ['active', 'backordered'] } };
    if (docId) { q['source.docId'] = docId; if (docType) q['source.docType'] = docType; }
    if (itemId) q.itemId = itemId;
    if (!docId && !itemId) throw new ApiError(400, 'Say which document or item to release');

    const rows = await StockReservation.find(q);
    for (const r of rows) {
      r.state = 'released';
      r.releasedAt = new Date();
      r.notes = r.notes || 'Released';
      await r.save();
    }
    logger.info(`[reservation] released ${rows.length} reservation(s) for ${docType || 'item'} ${docId || itemId}`);
    return { released: rows.length };
  }

  /**
   * The goods shipped. This closes the promise ONLY — the stock movement and
   * COGS are posted by the invoice/sale path (one accounting engine).
   */
  async fulfil(businessId, { docType, docId }, user) {
    const rows = await StockReservation.find({
      businessId, state: 'active',
      ...(docType ? { 'source.docType': docType } : {}),
      'source.docId': docId,
    });
    for (const r of rows) {
      r.state = 'fulfilled';
      r.fulfilledAt = new Date();
      await r.save();
    }
    return { fulfilled: rows.length };
  }

  /**
   * Backorders that stock has arrived for — the "you can ship these now" list.
   */
  async fillableBackorders(businessId) {
    const rows = await StockReservation.find({ businessId, state: 'backordered' })
      .populate('itemId', 'name sku currentStock unit')
      .sort({ createdAt: 1 })
      .lean();
    const out = [];
    for (const r of rows) {
      if (!r.itemId) continue;
      const atp = await this.availableToPromise(businessId, r.itemId._id);
      if (atp.available >= r.qty) {
        out.push({
          reservationId: r._id, itemId: r.itemId._id, name: r.itemId.name,
          qty: r.qty, available: atp.available,
          source: r.source, waitingSince: r.createdAt,
        });
      }
    }
    return out;
  }
}

module.exports = new StockReservationService();

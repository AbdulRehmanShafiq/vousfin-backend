// services/inventoryReports.service.js
//
// Inventory Engine Phase 10 — reporting.
//
// Every number here is DERIVED from the stock sub-ledger (and, for revenue,
// from the invoices themselves). Nothing is stored, nothing is cached, so a
// report can never disagree with the books: if a report looks wrong, the
// movements are wrong, and the integrity gate will say so.
'use strict';

const mongoose = require('mongoose');
const StockMovement = require('../models/StockMovement.model');
const InventoryItem = require('../models/InventoryItem.model');
const { ApiError } = require('../utils/ApiError');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const oid = (v) => new mongoose.Types.ObjectId(String(v));

// Movement types that represent goods actually sold (the COGS side).
const SOLD_TYPES = ['sale'];

class InventoryReportsService {
  /**
   * Valuation AS OF a date — what the stock was worth on the night of X.
   * Replays the sub-ledger up to that instant, so it reconciles to the
   * Inventory account's balance on the same date.
   */
  async valuationAsOf(businessId, asOf = new Date()) {
    const when = new Date(asOf);
    if (isNaN(when.getTime())) throw new ApiError(400, 'That date is not valid');

    const rows = await StockMovement.aggregate([
      { $match: { businessId: oid(businessId), movementDate: { $lte: when } } },
      { $group: {
        _id: '$itemId',
        qty:   { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$qty',   { $multiply: ['$qty', -1] }] } },
        value: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$value', { $multiply: ['$value', -1] }] } },
      } },
    ]);
    const items = await InventoryItem.find({ businessId: oid(businessId) }).select('name sku unit category').lean();
    const byId = new Map(items.map((i) => [String(i._id), i]));

    const lines = rows
      .filter((r) => Math.abs(r.qty) > 0.0001 || Math.abs(r.value) >= 0.01)
      .map((r) => {
        const i = byId.get(String(r._id)) || {};
        return {
          itemId: r._id, name: i.name || 'Unknown item', sku: i.sku || null,
          category: i.category || null, unit: i.unit || 'units',
          qty: r2(r.qty), value: r2(r.value),
          unitCost: r.qty > 0 ? r2(r.value / r.qty) : 0,
        };
      })
      .sort((a, b) => b.value - a.value);

    return {
      asOf: when,
      totalValue: r2(lines.reduce((s, l) => s + l.value, 0)),
      itemCount: lines.length,
      lines,
    };
  }

  /**
   * Turnover — how many times stock sold through in a period, and how long a
   * unit sits on the shelf. Cost of goods sold ÷ average stock held.
   */
  async turnover(businessId, { startDate, endDate } = {}) {
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate ? new Date(startDate) : new Date(end.getFullYear(), end.getMonth() - 11, 1);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new ApiError(400, 'Those dates are not valid');

    const [opening, closing, sold] = await Promise.all([
      this.valuationAsOf(businessId, start),
      this.valuationAsOf(businessId, end),
      StockMovement.aggregate([
        { $match: {
          businessId: oid(businessId),
          movementType: { $in: SOLD_TYPES },
          movementDate: { $gte: start, $lte: end },
        } },
        { $group: { _id: '$itemId', cogs: { $sum: '$value' }, qty: { $sum: '$qty' } } },
      ]),
    ]);

    const openByItem = new Map(opening.lines.map((l) => [String(l.itemId), l]));
    const closeByItem = new Map(closing.lines.map((l) => [String(l.itemId), l]));
    const soldByItem = new Map(sold.map((s) => [String(s._id), s]));

    const itemIds = new Set([...openByItem.keys(), ...closeByItem.keys(), ...soldByItem.keys()]);
    const lines = [...itemIds].map((id) => {
      const o = openByItem.get(id); const c = closeByItem.get(id); const s = soldByItem.get(id);
      const avg = r2(((o?.value || 0) + (c?.value || 0)) / 2);
      const cogs = r2(s?.cogs || 0);
      const turns = avg > 0 ? r2(cogs / avg) : 0;
      return {
        itemId: id, name: c?.name || o?.name || 'Unknown item',
        openingValue: r2(o?.value || 0), closingValue: r2(c?.value || 0),
        averageValue: avg, cogs, qtySold: r2(s?.qty || 0),
        turns, daysOnHand: turns > 0 ? Math.round(365 / turns) : null,
      };
    }).sort((a, b) => b.cogs - a.cogs);

    const totalCogs = r2(lines.reduce((s, l) => s + l.cogs, 0));
    const totalAvg = r2(lines.reduce((s, l) => s + l.averageValue, 0));
    const overallTurns = totalAvg > 0 ? r2(totalCogs / totalAvg) : 0;

    return {
      startDate: start, endDate: end,
      totalCogs, averageStockValue: totalAvg,
      turns: overallTurns,
      daysOnHand: overallTurns > 0 ? Math.round(365 / overallTurns) : null,
      lines,
    };
  }

  /**
   * Stock aging — how long what you're holding has been sitting there, from
   * the receipts that are still on hand (newest receipts are what remain).
   */
  async aging(businessId, { buckets = [30, 60, 90, 180] } = {}) {
    const now = Date.now();
    const edges = [...buckets].sort((a, b) => a - b);
    const labels = [
      `0-${edges[0]} days`,
      ...edges.slice(1).map((e, i) => `${edges[i] + 1}-${e} days`),
      `${edges[edges.length - 1] + 1}+ days`,
    ];

    // What's on hand — and what it's worth — is replayed from the sub-ledger,
    // exactly as valuationAsOf() does, so the two reports cannot disagree.
    // item.currentStock/unitCostPrice is a cached projection: reading it here
    // would put a second source of truth behind the same number.
    const onHand = await StockMovement.aggregate([
      { $match: { businessId: oid(businessId) } },
      { $group: {
        _id: '$itemId',
        qty:   { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$qty',   { $multiply: ['$qty', -1] }] } },
        value: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$value', { $multiply: ['$value', -1] }] } },
      } },
      { $match: { qty: { $gt: 0.0001 } } },
    ]);
    if (!onHand.length) return { labels, totals: labels.map(() => 0), totalValue: 0, lines: [] };

    // Every item's receipts, newest-first, in one pass rather than per item.
    const receiptRows = await StockMovement.aggregate([
      { $match: { businessId: oid(businessId), direction: 'in', qty: { $gt: 0 } } },
      { $sort: { movementDate: -1, _id: -1 } },
      { $group: { _id: '$itemId', receipts: { $push: { qty: '$qty', movementDate: '$movementDate' } } } },
    ]);
    const receiptsById = new Map(receiptRows.map((r) => [String(r._id), r.receipts]));

    const items = await InventoryItem.find({ businessId: oid(businessId) }).select('name sku unit').lean();
    const byId = new Map(items.map((i) => [String(i._id), i]));

    const bucketFor = (days) => {
      const i = edges.findIndex((e) => days <= e);
      return i === -1 ? labels.length - 1 : i;
    };

    const lines = [];
    for (const row of onHand) {
      const item = byId.get(String(row._id)) || {};
      const qty = r2(row.qty);
      const value = r2(row.value);

      // Age comes from the receipts (newest arrivals are what's still here);
      // value does NOT. Every unit on hand carries the same cost under
      // weighted-average and standard costing, so the bands split the carrying
      // value by quantity. Valuing each band at what that receipt originally
      // cost — as this once did — makes the bands drift away from the balance
      // sheet the moment a revaluation or landed cost re-marks the holding.
      const unitCarrying = qty > 0 ? value / qty : 0;
      const qtyBuckets = new Array(labels.length).fill(0);
      let remaining = qty;
      for (const rec of receiptsById.get(String(row._id)) || []) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, rec.qty);
        qtyBuckets[bucketFor(Math.floor((now - new Date(rec.movementDate).getTime()) / 86400000))] += take;
        remaining = r2(remaining - take);
      }
      // Stock with no receipt behind it predates the sub-ledger: call it oldest.
      if (remaining > 0) qtyBuckets[labels.length - 1] += remaining;

      const valBuckets = qtyBuckets.map((q) => r2(q * unitCarrying));
      // Pennies lost to rounding land on the largest band, so Σ bands == value.
      const rounding = r2(value - valBuckets.reduce((s, v) => s + v, 0));
      if (rounding !== 0) {
        let bi = 0;
        for (let i = 1; i < valBuckets.length; i += 1) if (valBuckets[i] > valBuckets[bi]) bi = i;
        valBuckets[bi] = r2(valBuckets[bi] + rounding);
      }

      lines.push({
        itemId: row._id,
        name: item.name || 'Unknown item',
        sku: item.sku || null,
        unit: item.unit || 'units',
        qty,
        value,
        qtyBuckets: qtyBuckets.map(r2),
        buckets: valBuckets,
      });
    }
    lines.sort((a, b) => b.value - a.value);

    const totals = labels.map((_, i) => r2(lines.reduce((s, l) => s + l.buckets[i], 0)));
    return { labels, totals, totalValue: r2(totals.reduce((s, t) => s + t, 0)), lines };
  }

  /**
   * Margin by item — what you sold it for (invoices) minus what it cost you
   * (the sub-ledger). Revenue and cost come from different sources on purpose:
   * each is read from its own authority, never from a stored summary.
   *
   * Both sides answer to POSTED-NESS, not to workflow state. The stock
   * sub-ledger only moves when an invoice posts, so if revenue counted an
   * unposted invoice the two sides would be reading different populations and
   * the margin would be fiction (revenue with no cost behind it = a 100%
   * margin the income statement never agreed with).
   */
  async marginByItem(businessId, { startDate, endDate } = {}) {
    const Invoice = require('../models/Invoice.model');
    const { INVOICE_STATES } = require('../config/constants');
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate ? new Date(startDate) : new Date(end.getFullYear(), end.getMonth(), 1);

    const [revenueRows, costRows] = await Promise.all([
      Invoice.aggregate([
        { $match: {
          businessId: oid(businessId),
          isArchived: { $ne: true },
          // An invoice earns revenue when it posts its AR/revenue journal —
          // never merely by reaching a state. Filtering on `state` alone let an
          // approved-but-unposted invoice contribute revenue the GL had never
          // recognized (and for which no COGS could exist).
          $or: [
            { arJournalId:          { $ne: null } },
            { linkedJournalEntryId: { $ne: null } },
          ],
          // Voided/cancelled revenue is reversed (or never belonged) in the GL,
          // so exclude it even though the document still carries its journal id.
          // Names come from the enum: the hand-typed 'void' here matched no
          // state at all, silently counting every voided invoice as revenue.
          state: { $nin: [INVOICE_STATES.DRAFT, INVOICE_STATES.CANCELLED, INVOICE_STATES.VOIDED] },
          issueDate: { $gte: start, $lte: end },
        } },
        { $unwind: '$lineItems' },
        { $match: { 'lineItems.inventoryItemId': { $ne: null } } },
        { $group: {
          _id: '$lineItems.inventoryItemId',
          revenue: { $sum: { $multiply: ['$lineItems.quantity', '$lineItems.unitPrice'] } },
          qty: { $sum: '$lineItems.quantity' },
        } },
      ]),
      StockMovement.aggregate([
        { $match: {
          businessId: oid(businessId),
          movementType: { $in: SOLD_TYPES },
          movementDate: { $gte: start, $lte: end },
        } },
        { $group: { _id: '$itemId', cogs: { $sum: '$value' }, qty: { $sum: '$qty' } } },
      ]),
    ]);

    const costById = new Map(costRows.map((c) => [String(c._id), c]));
    const items = await InventoryItem.find({ businessId: oid(businessId) }).select('name sku').lean();
    const nameById = new Map(items.map((i) => [String(i._id), i]));

    const lines = revenueRows.map((rev) => {
      const id = String(rev._id);
      const cost = costById.get(id);
      const revenue = r2(rev.revenue);
      const cogs = r2(cost?.cogs || 0);
      const profit = r2(revenue - cogs);
      return {
        itemId: rev._id,
        name: nameById.get(id)?.name || 'Unknown item',
        sku: nameById.get(id)?.sku || null,
        qtySold: r2(rev.qty), revenue, cogs, profit,
        marginPct: revenue > 0 ? r2((profit / revenue) * 100) : 0,
      };
    }).sort((a, b) => b.profit - a.profit);

    const revenue = r2(lines.reduce((s, l) => s + l.revenue, 0));
    const cogs = r2(lines.reduce((s, l) => s + l.cogs, 0));
    return {
      startDate: start, endDate: end,
      revenue, cogs, profit: r2(revenue - cogs),
      marginPct: revenue > 0 ? r2(((revenue - cogs) / revenue) * 100) : 0,
      lines,
    };
  }

  /**
   * Slow movers — stock with money tied up in it that isn't selling.
   */
  async slowMovers(businessId, { days = 90 } = {}) {
    const since = new Date(Date.now() - Number(days) * 86400000);
    const [items, moved] = await Promise.all([
      InventoryItem.find({ businessId: oid(businessId), isActive: { $ne: false }, currentStock: { $gt: 0 } })
        .select('name sku unit currentStock unitCostPrice').lean(),
      StockMovement.distinct('itemId', {
        businessId: oid(businessId),
        movementType: { $in: SOLD_TYPES },
        movementDate: { $gte: since },
      }),
    ]);
    const movedSet = new Set(moved.map(String));
    const lines = items
      .filter((i) => !movedSet.has(String(i._id)))
      .map((i) => ({
        itemId: i._id, name: i.name, sku: i.sku, unit: i.unit,
        qty: r2(i.currentStock), value: r2(i.currentStock * (i.unitCostPrice || 0)),
      }))
      .sort((a, b) => b.value - a.value);
    return {
      days: Number(days),
      tiedUpValue: r2(lines.reduce((s, l) => s + l.value, 0)),
      itemCount: lines.length,
      lines,
    };
  }

  /**
   * Lots expiring soon — the report that stops you selling expired goods
   * (and tells you what to discount first).
   */
  async expiringLots(businessId, { days = 60 } = {}) {
    const stockMovementService = require('./stockMovement.service');
    const horizon = new Date(Date.now() + Number(days) * 86400000);
    const items = await InventoryItem.find({ businessId: oid(businessId), trackLots: true, isActive: { $ne: false } })
      .select('name sku unit unitCostPrice').lean();

    const out = [];
    for (const item of items) {
      const lots = await stockMovementService.lotBalances(businessId, item._id);
      for (const lot of lots) {
        if (!lot.expiryDate) continue;
        const expiry = new Date(lot.expiryDate);
        if (expiry > horizon) continue;
        const daysLeft = Math.ceil((expiry.getTime() - Date.now()) / 86400000);
        out.push({
          itemId: item._id, name: item.name, sku: item.sku, unit: item.unit,
          lot: lot.code, expiryDate: lot.expiryDate, qty: lot.qty,
          value: r2(lot.qty * (item.unitCostPrice || 0)),
          daysLeft, expired: daysLeft < 0,
        });
      }
    }
    out.sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate));
    return {
      horizonDays: Number(days),
      atRiskValue: r2(out.reduce((s, l) => s + l.value, 0)),
      expiredCount: out.filter((l) => l.expired).length,
      lots: out,
    };
  }
}

module.exports = new InventoryReportsService();

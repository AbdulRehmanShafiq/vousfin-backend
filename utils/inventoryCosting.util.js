// utils/inventoryCosting.util.js
// FIFO inventory costing — pure functions over cost layers.
// A cost layer is { qty, unitCost, addedAt? }. Oldest layer is index 0.
'use strict';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Consume `qty` units from FIFO cost layers (oldest first).
 * @returns {{ cogsAmount:number, unitCostUsed:number, remainingLayers:Array, shortfall:number }}
 */
function consumeFifo(layers, qty) {
  let remaining = Number(qty) || 0;
  let cogs = 0;
  const work = (layers || []).map((l) => ({
    qty: Number(l.qty) || 0,
    unitCost: Number(l.unitCost) || 0,
    ...(l.addedAt ? { addedAt: l.addedAt } : {}),
  }));

  let i = 0;
  while (remaining > 0 && i < work.length) {
    const take = Math.min(remaining, work[i].qty);
    cogs += take * work[i].unitCost;
    work[i].qty = r2(work[i].qty - take);
    remaining = r2(remaining - take);
    if (work[i].qty <= 0) i += 1; // layer exhausted, advance
    else break;                    // partial layer keeps its place
  }

  const remainingLayers = work.slice(i).filter((l) => l.qty > 0);
  const consumed = (Number(qty) || 0) - remaining;
  const cogsAmount = r2(cogs);
  return {
    cogsAmount,
    unitCostUsed: consumed > 0 ? r2(cogsAmount / consumed) : 0,
    remainingLayers,
    shortfall: remaining > 0 ? r2(remaining) : 0,
  };
}

/**
 * Quote a stock consumption for an item WITHOUT mutating anything — the ONE
 * costing path (INV-1). Both the journal's COGS amount and the physical
 * reduceStock consume through this function, so the posted COGS can never
 * diverge from the subledger movement.
 *
 * @param {Object} item  { valuationMethod, currentStock, unitCostPrice, costLayers }
 * @param {number} qty   units to consume (> 0)
 * @returns {{ cogsAmount:number, unitCostUsed:number, remainingLayers:(Array|null),
 *             method:string, shortfall:number }}
 *          remainingLayers is null for weighted_average (layers unused).
 */
function quoteConsumption(item, qty) {
  const q = Number(qty) || 0;
  const method = item.valuationMethod === 'fifo' ? 'fifo' : 'weighted_average';
  if (q <= 0) {
    return { cogsAmount: 0, unitCostUsed: 0, remainingLayers: method === 'fifo' ? (item.costLayers || []) : null, method, shortfall: 0 };
  }
  if (method === 'fifo') {
    // Migration-safe seeding: an item switched to FIFO before any layered
    // receipt consumes its opening stock at the stored weighted-average cost.
    const layers = (item.costLayers && item.costLayers.length)
      ? item.costLayers.map((l) => ({ qty: l.qty, unitCost: l.unitCost, ...(l.addedAt ? { addedAt: l.addedAt } : {}) }))
      : (item.currentStock > 0 ? [{ qty: item.currentStock, unitCost: item.unitCostPrice }] : []);
    const res = consumeFifo(layers, q);
    return {
      cogsAmount: res.cogsAmount,
      unitCostUsed: res.unitCostUsed || item.unitCostPrice || 0,
      remainingLayers: res.remainingLayers,
      method,
      shortfall: res.shortfall,
    };
  }
  const available = Number(item.currentStock) || 0;
  return {
    cogsAmount: r2(q * (item.unitCostPrice || 0)),
    unitCostUsed: item.unitCostPrice || 0,
    remainingLayers: null,
    method,
    shortfall: q > available ? r2(q - available) : 0,
  };
}

/**
 * Remove a RECEIPT from FIFO layers (INV-3 — GRN cancel / receipt reversal).
 * A reversal must undo the received batch at its receipt cost, not consume
 * oldest layers like a sale. Walks from the NEWEST layer, preferring layers
 * whose unitCost matches the receipt cost (±0.005); any remainder falls back
 * to newest-first removal so the quantity always nets out.
 *
 * @returns {{ remainingLayers:Array, removedQty:number, removedValue:number }}
 */
function removeReceiptLayers(layers, qty, unitCost) {
  let remaining = Number(qty) || 0;
  let removedValue = 0;
  const target = Number(unitCost) || 0;
  const work = (layers || []).map((l) => ({
    qty: Number(l.qty) || 0,
    unitCost: Number(l.unitCost) || 0,
    ...(l.addedAt ? { addedAt: l.addedAt } : {}),
  }));

  const takeFrom = (idx, take) => {
    work[idx].qty = r2(work[idx].qty - take);
    remaining = r2(remaining - take);
    removedValue += take * work[idx].unitCost;
  };

  // Pass 1 — newest-first, cost-matched layers (the batch being reversed).
  for (let i = work.length - 1; i >= 0 && remaining > 0; i -= 1) {
    if (work[i].qty <= 0) continue;
    if (Math.abs(work[i].unitCost - target) > 0.005) continue;
    takeFrom(i, Math.min(remaining, work[i].qty));
  }
  // Pass 2 — newest-first fallback for any remainder (cost drifted / partial).
  for (let i = work.length - 1; i >= 0 && remaining > 0; i -= 1) {
    if (work[i].qty <= 0) continue;
    takeFrom(i, Math.min(remaining, work[i].qty));
  }

  return {
    remainingLayers: work.filter((l) => l.qty > 0),
    removedQty: r2((Number(qty) || 0) - remaining),
    removedValue: r2(removedValue),
  };
}

module.exports = { consumeFifo, quoteConsumption, removeReceiptLayers, r2 };

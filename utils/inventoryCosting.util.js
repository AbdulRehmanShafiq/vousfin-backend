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
  // Phase 8 — standard costing consumes at the standard, never the actual.
  if (item.valuationMethod === 'standard') {
    const std = Number(item.standardCost) > 0 ? Number(item.standardCost) : (Number(item.unitCostPrice) || 0);
    const avail = Number(item.currentStock) || 0;
    return {
      cogsAmount: r2(q * std), unitCostUsed: std, remainingLayers: null,
      method: 'standard', shortfall: q > avail ? r2(q - avail) : 0,
    };
  }
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
 * Quote a stock RECEIPT — the mirror of quoteConsumption (Phase 8).
 *
 * Under standard costing, stock is carried at the standard cost and any
 * difference from what the vendor actually charged is a Purchase Price
 * Variance recognised immediately (never buried in inventory). The caller
 * posts the PPV leg, so it must know the split BEFORE building the journal —
 * exactly the quote-then-apply discipline that fixed INV-1.
 *
 * @returns {{ unitCostIn:number, valueIn:number, variance:number, method:string }}
 *          variance > 0 = paid MORE than standard (unfavourable, DR PPV)
 */
function quoteReceipt(item, qty, actualUnitCost) {
  const q = Number(qty) || 0;
  const actual = Number(actualUnitCost) || 0;
  const method = ['fifo', 'standard'].includes(item?.valuationMethod) ? item.valuationMethod : 'weighted_average';
  if (method === 'standard') {
    const std = Number(item.standardCost) > 0 ? Number(item.standardCost) : (Number(item.unitCostPrice) || 0);
    return { unitCostIn: std, valueIn: r2(q * std), variance: r2(q * (actual - std)), method };
  }
  return { unitCostIn: actual, valueIn: r2(q * actual), variance: 0, method };
}

/**
 * Allocate a total across weights, penny-perfect (Phase 4 — landed costs).
 * Rounds each share to cents and gives the rounding remainder to the largest
 * weight, so Σ(allocations) === total exactly. Zero/absent weights split evenly.
 *
 * @param {number[]} weights  e.g. line values, quantities or weights
 * @param {number} total      amount to spread
 * @returns {number[]} allocations aligned to `weights`
 */
function allocateByWeights(weights, total) {
  const w = (weights || []).map((x) => Math.max(0, Number(x) || 0));
  const t = r2(total);
  if (w.length === 0) return [];
  const sum = w.reduce((s, x) => s + x, 0);
  const basis = sum > 0 ? w : w.map(() => 1); // no weights → split evenly
  const basisSum = basis.reduce((s, x) => s + x, 0);

  const out = basis.map((x) => r2((t * x) / basisSum));
  const drift = r2(t - out.reduce((s, x) => s + x, 0));
  if (Math.abs(drift) >= 0.01) {
    // Hand the remainder to the biggest share — never lose or invent a cent.
    let idx = 0;
    basis.forEach((x, i) => { if (x > basis[idx]) idx = i; });
    out[idx] = r2(out[idx] + drift);
  }
  return out;
}

/**
 * Capitalize additional value into FIFO layers without moving quantity
 * (Phase 4 — landed cost on a FIFO item). Targets the NEWEST layers up to the
 * received quantity, since those are the batch the cost belongs to.
 *
 * @returns {{ layers:Array, appliedValue:number }}
 */
function addValueToLayers(layers, qty, addValue) {
  const work = (layers || []).map((l) => ({
    qty: Number(l.qty) || 0,
    unitCost: Number(l.unitCost) || 0,
    ...(l.addedAt ? { addedAt: l.addedAt } : {}),
  }));
  let remainingQty = Number(qty) || 0;
  const value = r2(addValue);
  if (remainingQty <= 0 || work.length === 0 || Math.abs(value) < 0.005) {
    return { layers: work, appliedValue: 0 };
  }

  // Collect the newest layers covering `qty`, then spread the value across them
  // in proportion to the quantity taken from each.
  const targets = [];
  for (let i = work.length - 1; i >= 0 && remainingQty > 0; i -= 1) {
    if (work[i].qty <= 0) continue;
    const take = Math.min(remainingQty, work[i].qty);
    targets.push({ i, take });
    remainingQty = r2(remainingQty - take);
  }
  const shares = allocateByWeights(targets.map((t) => t.take), value);
  targets.forEach((t, k) => {
    const perUnit = shares[k] / t.take;
    work[t.i].unitCost = r2(work[t.i].unitCost + perUnit);
  });
  return { layers: work, appliedValue: r2(shares.reduce((s, x) => s + x, 0)) };
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

module.exports = {
  consumeFifo, quoteConsumption, quoteReceipt, removeReceiptLayers,
  allocateByWeights, addValueToLayers, r2,
};

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

module.exports = { consumeFifo, r2 };

// tests/unit/utils/inventoryCosting.test.js
'use strict';
const { consumeFifo, quoteConsumption, removeReceiptLayers } = require('../../../utils/inventoryCosting.util');

describe('consumeFifo', () => {
  test('consumes oldest layers first and blends COGS across layers', () => {
    const r = consumeFifo([{ qty: 10, unitCost: 5 }, { qty: 10, unitCost: 8 }], 15);
    expect(r.cogsAmount).toBe(90);      // 10*5 + 5*8
    expect(r.unitCostUsed).toBe(6);     // 90 / 15
    expect(r.remainingLayers).toEqual([{ qty: 5, unitCost: 8 }]);
    expect(r.shortfall).toBe(0);
  });

  test('fully consuming the first layer leaves later layers intact', () => {
    const r = consumeFifo([{ qty: 4, unitCost: 3 }, { qty: 6, unitCost: 7 }], 4);
    expect(r.cogsAmount).toBe(12);
    expect(r.remainingLayers).toEqual([{ qty: 6, unitCost: 7 }]);
  });

  test('consuming all stock returns no remaining layers', () => {
    const r = consumeFifo([{ qty: 5, unitCost: 2 }], 5);
    expect(r.cogsAmount).toBe(10);
    expect(r.remainingLayers).toEqual([]);
  });

  test('reports a shortfall when qty exceeds available layers', () => {
    const r = consumeFifo([{ qty: 3, unitCost: 4 }], 5);
    expect(r.cogsAmount).toBe(12);      // only 3 available
    expect(r.shortfall).toBe(2);
    expect(r.remainingLayers).toEqual([]);
  });
});

// INV-1 — the ONE costing path: a quote must equal what reduceStock consumes.
describe('quoteConsumption', () => {
  test('weighted average: qty × unitCostPrice, no layer mutation', () => {
    const item = { valuationMethod: 'weighted_average', currentStock: 20, unitCostPrice: 7.5 };
    const q = quoteConsumption(item, 4);
    expect(q.cogsAmount).toBe(30);
    expect(q.unitCostUsed).toBe(7.5);
    expect(q.method).toBe('weighted_average');
    expect(q.remainingLayers).toBeNull();
  });

  test('fifo: consumes oldest layers first — matches consumeFifo exactly', () => {
    const layers = [{ qty: 10, unitCost: 5 }, { qty: 10, unitCost: 8 }];
    const item = { valuationMethod: 'fifo', currentStock: 20, unitCostPrice: 6.5, costLayers: layers };
    const q = quoteConsumption(item, 15);
    const direct = consumeFifo(layers, 15);
    expect(q.cogsAmount).toBe(direct.cogsAmount); // 90, NOT 15 × 6.5 = 97.5 (the old WAC bug)
    expect(q.cogsAmount).toBe(90);
    expect(q.remainingLayers).toEqual(direct.remainingLayers);
  });

  test('fifo does not mutate the item’s stored layers (pure quote)', () => {
    const layers = [{ qty: 10, unitCost: 5 }];
    const item = { valuationMethod: 'fifo', currentStock: 10, unitCostPrice: 5, costLayers: layers };
    quoteConsumption(item, 6);
    expect(item.costLayers).toEqual([{ qty: 10, unitCost: 5 }]);
  });

  test('fifo with no recorded layers seeds from current stock at stored WAC (migration path)', () => {
    const item = { valuationMethod: 'fifo', currentStock: 8, unitCostPrice: 12, costLayers: [] };
    const q = quoteConsumption(item, 3);
    expect(q.cogsAmount).toBe(36); // 3 × 12
    expect(q.remainingLayers).toEqual([{ qty: 5, unitCost: 12 }]);
  });

  test('defaults to weighted average when valuationMethod is absent (legacy items)', () => {
    const q = quoteConsumption({ currentStock: 5, unitCostPrice: 10 }, 2);
    expect(q.method).toBe('weighted_average');
    expect(q.cogsAmount).toBe(20);
  });
});

// INV-3 — reversing a receipt removes the received batch, not the oldest stock.
describe('removeReceiptLayers', () => {
  test('removes the newest cost-matched layer (the batch being reversed)', () => {
    const layers = [{ qty: 10, unitCost: 5 }, { qty: 6, unitCost: 9 }];
    const r = removeReceiptLayers(layers, 6, 9);
    expect(r.removedQty).toBe(6);
    expect(r.removedValue).toBe(54);                       // 6 × 9 — receipt value exactly
    expect(r.remainingLayers).toEqual([{ qty: 10, unitCost: 5 }]); // old stock untouched
  });

  test('partial reversal shrinks the matched layer in place', () => {
    const r = removeReceiptLayers([{ qty: 10, unitCost: 5 }, { qty: 6, unitCost: 9 }], 4, 9);
    expect(r.removedValue).toBe(36);
    expect(r.remainingLayers).toEqual([{ qty: 10, unitCost: 5 }, { qty: 2, unitCost: 9 }]);
  });

  test('falls back to newest-first when no layer matches the receipt cost', () => {
    const r = removeReceiptLayers([{ qty: 10, unitCost: 5 }, { qty: 6, unitCost: 9 }], 8, 7);
    expect(r.removedQty).toBe(8);
    // newest-first: all 6 @ 9, then 2 @ 5 = 54 + 10
    expect(r.removedValue).toBe(64);
    expect(r.remainingLayers).toEqual([{ qty: 8, unitCost: 5 }]);
  });
});

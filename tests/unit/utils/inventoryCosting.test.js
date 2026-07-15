// tests/unit/utils/inventoryCosting.test.js
'use strict';
const {
  consumeFifo, quoteConsumption, quoteReceipt, removeReceiptLayers,
  allocateByWeights, addValueToLayers,
} = require('../../../utils/inventoryCosting.util');

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

// Phase 8 — standard costing: stock enters at the standard, the gap is variance.
describe('quoteReceipt', () => {
  test('standard costing values stock at standard and splits out the variance', () => {
    const item = { valuationMethod: 'standard', standardCost: 10, unitCostPrice: 10 };
    const r = quoteReceipt(item, 100, 11.5);   // paid 11.50, standard is 10
    expect(r.valueIn).toBe(1000);              // inventory takes only the standard
    expect(r.unitCostIn).toBe(10);
    expect(r.variance).toBe(150);              // 100 × 1.50 unfavourable → DR PPV
  });

  test('buying below standard yields a favourable (negative) variance', () => {
    const r = quoteReceipt({ valuationMethod: 'standard', standardCost: 10 }, 50, 9);
    expect(r.valueIn).toBe(500);
    expect(r.variance).toBe(-50);              // → CR PPV
  });

  test('weighted-average and FIFO receipts have no variance — actual cost is the cost', () => {
    expect(quoteReceipt({ valuationMethod: 'weighted_average' }, 10, 7).variance).toBe(0);
    expect(quoteReceipt({ valuationMethod: 'fifo' }, 10, 7)).toMatchObject({ valueIn: 70, variance: 0 });
  });

  test('a standard-cost item with no standard set falls back to its current cost', () => {
    const r = quoteReceipt({ valuationMethod: 'standard', standardCost: 0, unitCostPrice: 8 }, 5, 8);
    expect(r.valueIn).toBe(40);
    expect(r.variance).toBe(0);
  });
});

describe('quoteConsumption — standard costing (Phase 8)', () => {
  test('consumes at the standard cost, not the average', () => {
    const q = quoteConsumption({ valuationMethod: 'standard', standardCost: 10, unitCostPrice: 12, currentStock: 50 }, 4);
    expect(q.cogsAmount).toBe(40);   // 4 × 10 standard
    expect(q.method).toBe('standard');
  });
});

// Phase 4 — landed cost allocation must never lose or invent a cent.
describe('allocateByWeights', () => {
  test('splits in proportion to weights', () => {
    expect(allocateByWeights([100, 300], 40)).toEqual([10, 30]);
  });

  test('reconciles rounding so the parts always sum to the whole', () => {
    // 100/3 each = 33.333… → 33.33 × 3 = 99.99; the remainder must land somewhere
    const out = allocateByWeights([1, 1, 1], 100);
    expect(out.reduce((s, x) => s + x, 0)).toBe(100);
  });

  test('gives the rounding remainder to the largest share', () => {
    const out = allocateByWeights([1, 1, 8], 100);
    expect(out.reduce((s, x) => s + x, 0)).toBe(100);
    expect(out[2]).toBeGreaterThan(out[0]);
  });

  test('splits evenly when there are no weights to go on', () => {
    expect(allocateByWeights([0, 0], 50)).toEqual([25, 25]);
  });

  test('handles an empty line set', () => {
    expect(allocateByWeights([], 10)).toEqual([]);
  });
});

// Phase 4 — capitalizing freight into FIFO batches: value up, quantity flat.
describe('addValueToLayers', () => {
  test('adds cost to the newest layers covering the received quantity', () => {
    const layers = [{ qty: 10, unitCost: 5 }, { qty: 10, unitCost: 8 }];
    const r = addValueToLayers(layers, 10, 20);      // 20 freight over the newest 10 units
    expect(r.appliedValue).toBe(20);
    expect(r.layers[0]).toEqual({ qty: 10, unitCost: 5 });   // older batch untouched
    expect(r.layers[1]).toEqual({ qty: 10, unitCost: 10 });  // 8 + 2/unit
  });

  test('spreads across several layers when the receipt spans them', () => {
    const r = addValueToLayers([{ qty: 5, unitCost: 4 }, { qty: 5, unitCost: 6 }], 10, 20);
    expect(r.appliedValue).toBe(20);
    expect(r.layers[0].unitCost).toBe(6);   // 4 + 2
    expect(r.layers[1].unitCost).toBe(8);   // 6 + 2
  });

  test('quantity never changes — only value', () => {
    const r = addValueToLayers([{ qty: 7, unitCost: 3 }], 7, 14);
    expect(r.layers[0].qty).toBe(7);
    expect(r.layers[0].unitCost).toBe(5);
  });

  test('a zero charge is a no-op', () => {
    const r = addValueToLayers([{ qty: 5, unitCost: 2 }], 5, 0);
    expect(r.appliedValue).toBe(0);
    expect(r.layers).toEqual([{ qty: 5, unitCost: 2 }]);
  });
});

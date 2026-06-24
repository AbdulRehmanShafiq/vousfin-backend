// tests/unit/utils/inventoryCosting.test.js
'use strict';
const { consumeFifo } = require('../../../utils/inventoryCosting.util');

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

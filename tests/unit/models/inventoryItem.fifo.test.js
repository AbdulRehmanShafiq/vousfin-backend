// tests/unit/models/inventoryItem.fifo.test.js
// Exercises the FIFO branch of addStock/reduceStock on an item-like object (save mocked).
'use strict';
const InventoryItem = require('../../../models/InventoryItem.model');
const { addStock, reduceStock } = InventoryItem.schema.methods;

const layerPairs = (item) => item.costLayers.map((l) => ({ qty: l.qty, unitCost: l.unitCost }));

test('FIFO: two purchase batches then a cross-layer issue costs oldest-first', async () => {
  const item = { currentStock: 0, unitCostPrice: 0, valuationMethod: 'fifo', costLayers: [], save: jest.fn().mockResolvedValue(true) };

  await addStock.call(item, 10, 5); // batch 1: 10 @ 5
  await addStock.call(item, 10, 8); // batch 2: 10 @ 8
  expect(item.currentStock).toBe(20);
  expect(item.unitCostPrice).toBe(6.5); // weighted-avg summary
  expect(layerPairs(item)).toEqual([{ qty: 10, unitCost: 5 }, { qty: 10, unitCost: 8 }]);

  const r = await reduceStock.call(item, 15); // consume 10@5 + 5@8
  expect(r.cogsAmount).toBe(90);
  expect(r.unitCostUsed).toBe(6);
  expect(item.currentStock).toBe(5);
  expect(layerPairs(item)).toEqual([{ qty: 5, unitCost: 8 }]); // only newest layer remains
  expect(item.unitCostPrice).toBe(8); // valuation now reflects the remaining FIFO layer
});

test('weighted_average still costs at the blended unit price', async () => {
  const item = { currentStock: 0, unitCostPrice: 0, valuationMethod: 'weighted_average', costLayers: [], save: jest.fn().mockResolvedValue(true) };
  await addStock.call(item, 10, 5);
  await addStock.call(item, 10, 8); // avg 6.5
  const r = await reduceStock.call(item, 15);
  expect(r.unitCostUsed).toBe(6.5);
  expect(r.cogsAmount).toBe(97.5); // 15 * 6.5
});

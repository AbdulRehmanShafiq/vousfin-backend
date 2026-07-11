'use strict';
const { matchItemByName } = require('../../../utils/itemMatcher');

const ITEMS = [
  { _id: 'i1', name: 'Rice (bag)', unit: 'bags', unitCostPrice: 500, currentStock: 12 },
  { _id: 'i2', name: 'Sugar 1kg', unit: 'kg', unitCostPrice: 150, currentStock: 40 },
  { _id: 'i3', name: 'Basmati Rice Premium', unit: 'bags', unitCostPrice: 900, currentStock: 3 },
];

describe('matchItemByName', () => {
  test('exact match (case-insensitive) → confidence 1.0', () => {
    const r = matchItemByName(ITEMS, 'rice (bag)');
    expect(r.item._id).toBe('i1');
    expect(r.confidence).toBe(1.0);
    expect(r.matchType).toBe('exact');
  });

  test('word-overlap fuzzy match finds the tightest fit', () => {
    const r = matchItemByName(ITEMS, 'rice');
    expect(['i1', 'i3']).toContain(r.item._id);
    expect(r.confidence).toBeGreaterThan(0);
  });

  test('no match → null item, confidence 0', () => {
    const r = matchItemByName(ITEMS, 'diesel');
    expect(r.item).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.matchType).toBe('none');
  });

  test('empty inputs are safe', () => {
    expect(matchItemByName([], 'rice').item).toBeNull();
    expect(matchItemByName(ITEMS, '').item).toBeNull();
    expect(matchItemByName(null, 'rice').item).toBeNull();
  });

  test('returned item does not carry the temporary accountName field', () => {
    const r = matchItemByName(ITEMS, 'Sugar 1kg');
    expect(r.item.accountName).toBeUndefined();
    expect(r.item.name).toBe('Sugar 1kg');
  });
});

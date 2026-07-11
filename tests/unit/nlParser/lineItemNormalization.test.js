'use strict';
const { normalizeLineItems, normalizeExtraction } = require('../../../services/nlParser/services/normalizationService');

describe('normalizeLineItems', () => {
  test('clean extraction passes through', () => {
    const out = normalizeLineItems([{ name: 'rice', quantity: 10, unit: 'bags', unitPrice: 500 }], 5000);
    expect(out).toEqual([{ name: 'rice', quantity: 10, unit: 'bags', unitPrice: 500 }]);
  });

  test('AI arithmetic that disagrees with amount is repaired from amount', () => {
    // 10 × 600 = 6000 ≠ 5000 → unitPrice recomputed as amount / qty
    const out = normalizeLineItems([{ name: 'rice', quantity: 10, unit: 'bags', unitPrice: 600 }], 5000);
    expect(out[0].unitPrice).toBe(500);
  });

  test('missing unitPrice is derived from amount / quantity', () => {
    const out = normalizeLineItems([{ name: 'rice', quantity: 4, unit: 'bags', unitPrice: null }], 5000);
    expect(out[0].unitPrice).toBe(1250);
  });

  test('missing quantity is derived when amount / unitPrice is a near-integer', () => {
    const out = normalizeLineItems([{ name: 'rice', quantity: null, unit: 'bags', unitPrice: 500 }], 5000);
    expect(out[0].quantity).toBe(10);
  });

  test('nameless entries are dropped; non-arrays return []', () => {
    expect(normalizeLineItems([{ name: '', quantity: 1 }], 100)).toEqual([]);
    expect(normalizeLineItems(null, 100)).toEqual([]);
    expect(normalizeLineItems('junk', 100)).toEqual([]);
  });

  test('multi-item extractions are not arithmetic-repaired (v1)', () => {
    const raw = [
      { name: 'rice', quantity: 10, unit: 'bags', unitPrice: 300 },
      { name: 'sugar', quantity: 5, unit: 'kg', unitPrice: 150 },
    ];
    const out = normalizeLineItems(raw, 5000);
    expect(out[0].unitPrice).toBe(300); // untouched
  });
});

describe('normalizeExtraction — new fields', () => {
  test('purchaseIntent + saleAffectsStock + lineItems land on normalized', () => {
    const { normalized } = normalizeExtraction({
      intent: 'buy stock', transactionType: 'inventory_purchase', amount: 5000,
      lineItems: [{ name: 'rice', quantity: 10, unit: 'bags', unitPrice: 500 }],
      purchaseIntent: 'resale', saleAffectsStock: false,
      confidence: { intent: 0.9, amount: 0.9, date: 0.9, accountMapping: 0.9 },
    });
    expect(normalized.lineItems).toHaveLength(1);
    expect(normalized.purchaseIntent).toBe('resale');
    expect(normalized.saleAffectsStock).toBe(false);
  });

  test('invalid purchaseIntent → null; absent lineItems → []', () => {
    const { normalized } = normalizeExtraction({
      intent: 'x', transactionType: 'expense', amount: 100,
      purchaseIntent: 'because-i-wanted-it',
      confidence: {},
    });
    expect(normalized.purchaseIntent).toBeNull();
    expect(normalized.lineItems).toEqual([]);
  });
});

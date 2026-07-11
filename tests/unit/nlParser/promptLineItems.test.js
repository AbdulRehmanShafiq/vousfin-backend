'use strict';
const { buildSystemPrompt } = require('../../../services/nlParser/utils/promptBuilder');

const ITEMS = [
  { _id: 'i1', name: 'Rice (bag)', unit: 'bags' },
  { _id: 'i2', name: 'Sugar 1kg', unit: 'kg' },
];

describe('buildSystemPrompt — smart entry fields', () => {
  test('JSON schema includes lineItems, purchaseIntent, saleAffectsStock', () => {
    const p = buildSystemPrompt([], []);
    expect(p).toContain('"lineItems"');
    expect(p).toContain('"purchaseIntent"');
    expect(p).toContain('"saleAffectsStock"');
  });

  test('inventory item names are injected when provided', () => {
    const p = buildSystemPrompt([], ITEMS);
    expect(p).toContain('INVENTORY ITEMS THIS BUSINESS TRACKS');
    expect(p).toContain('"Rice (bag)"');
    expect(p).toContain('"Sugar 1kg"');
  });

  test('no inventory section when the business tracks nothing', () => {
    const p = buildSystemPrompt([], []);
    expect(p).not.toContain('INVENTORY ITEMS THIS BUSINESS TRACKS');
  });

  test('additional-details override rule is present', () => {
    const p = buildSystemPrompt([], []);
    expect(p).toContain('Additional details');
  });
});

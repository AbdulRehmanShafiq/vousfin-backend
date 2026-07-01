'use strict';
const { deriveLearningKey } = require('../../../utils/learningKey.helper');

describe('deriveLearningKey', () => {
  it('normalizes case and whitespace to a stable key', () => {
    expect(deriveLearningKey('  Paid   Electricity   Bill ')).toBe('paid electricity bill');
  });

  it('strips amounts, currency symbols and dates so recurring entries share a key', () => {
    const a = deriveLearningKey('Paid electricity bill 5000');
    const b = deriveLearningKey('Paid electricity bill Rs 6,200.50 on 2025-01-15');
    expect(a).toBe('paid electricity bill');
    expect(b).toBe('paid electricity bill');
    expect(a).toBe(b);
  });

  it('drops filler punctuation but keeps meaningful words', () => {
    expect(deriveLearningKey('AWS invoice #INV-2025/001 — cloud hosting')).toBe('aws invoice inv cloud hosting');
  });

  it('returns null for empty or too-short input', () => {
    expect(deriveLearningKey('')).toBeNull();
    expect(deriveLearningKey('   ')).toBeNull();
    expect(deriveLearningKey('a')).toBeNull();
    expect(deriveLearningKey(null)).toBeNull();
  });

  it('returns null when nothing meaningful survives normalization', () => {
    expect(deriveLearningKey('5000 2025-01-15 $$$')).toBeNull();
  });

  it('caps very long descriptions to a bounded key length', () => {
    const key = deriveLearningKey('word '.repeat(200));
    expect(key.length).toBeLessThanOrEqual(200);
  });
});

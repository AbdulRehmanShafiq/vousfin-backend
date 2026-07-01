'use strict';

const { buildClarification } = require('../../../services/nlParser/utils/clarificationBuilder');

const goodConfidence = { overall: 0.9, intent: 0.9, amount: 0.9, date: 0.9, accountMapping: 0.9 };
const goodData = {
  amount: 5000, transactionType: 'expense', paymentMethod: 'cash',
  cashFlowDirection: 'outflow', sourceAccount: 'Cash',
};

describe('buildClarification', () => {
  it('returns null when everything is clear', () => {
    expect(buildClarification(goodConfidence, goodData, { attempt: 0 })).toBeNull();
  });

  it('asks for the amount first when it is missing or invalid', () => {
    const c = buildClarification(goodConfidence, { ...goodData, amount: 0 }, { attempt: 0 });
    expect(c).toBeTruthy();
    expect(c.field).toBe('amount');
    expect(c.question).toMatch(/how much/i);
  });

  it('asks how it was paid when the payment source is ambiguous (and it is a cash-flow txn)', () => {
    const data = { ...goodData, paymentMethod: null, sourceAccount: null, cashFlowDirection: 'outflow' };
    const c = buildClarification(goodConfidence, data, { attempt: 0 });
    expect(c.field).toBe('paymentMethod');
    expect(Array.isArray(c.options)).toBe(true);
    expect(c.options.length).toBeGreaterThan(1);
  });

  it('does NOT ask about payment source for a non-cash transaction (e.g. depreciation)', () => {
    const data = { ...goodData, paymentMethod: null, sourceAccount: null, cashFlowDirection: 'non_cash' };
    expect(buildClarification(goodConfidence, data, { attempt: 0 })).toBeNull();
  });

  it('asks what the transaction was for when account mapping is uncertain', () => {
    const lowMap = { ...goodConfidence, accountMapping: 0.4 };
    const c = buildClarification(lowMap, goodData, { attempt: 0 });
    expect(c.field).toBe('purpose');
    expect(c.question).toMatch(/what was this for/i);
  });

  it('prioritises the amount question over payment/account questions', () => {
    const data = { ...goodData, amount: null, paymentMethod: null, sourceAccount: null };
    const lowMap = { ...goodConfidence, accountMapping: 0.3 };
    const c = buildClarification(lowMap, data, { attempt: 0 });
    expect(c.field).toBe('amount');
  });

  it('stops asking once the round cap is reached (never loops forever)', () => {
    const data = { ...goodData, amount: 0 };
    expect(buildClarification(goodConfidence, data, { attempt: 2, maxRounds: 2 })).toBeNull();
  });
});

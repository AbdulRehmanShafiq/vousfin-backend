/**
 * Regression for audit finding A6 — partial-payment settlement must round and snap
 * sub-cent floating-point residue to "fully paid", otherwise an AR/AP line can stay
 * PARTIALLY_PAID forever with dust like 5e-17 remaining.
 */
'use strict';

const { computeSettlement } = require('../../../services/transaction.service');

describe('computeSettlement (audit A6)', () => {
  test('partial payment leaves a rounded remaining balance', () => {
    const r = computeSettlement(100, 30, 0);
    expect(r.newRemaining).toBe(70);
    expect(r.fullyPaid).toBe(false);
    expect(r.newPartiallyPaid).toBe(30);
  });

  test('exact payoff is fully paid with zero remaining', () => {
    const r = computeSettlement(250.5, 250.5, 0);
    expect(r.newRemaining).toBe(0);
    expect(r.fullyPaid).toBe(true);
  });

  test('sub-cent float residue snaps to fully paid (the bug)', () => {
    // 0.1 + 0.2 === 0.30000000000000004; old `=== 0` check never triggered.
    const remaining = 0.1 + 0.2;
    const r = computeSettlement(remaining, 0.3, 0);
    expect(r.newRemaining).toBe(0);
    expect(r.fullyPaid).toBe(true);
  });

  test('accumulates partially-paid amount, rounded', () => {
    const r = computeSettlement(100, 33.33, 66.67);
    expect(r.newRemaining).toBe(66.67);
    expect(r.newPartiallyPaid).toBe(100);
    expect(r.fullyPaid).toBe(false);
  });
});

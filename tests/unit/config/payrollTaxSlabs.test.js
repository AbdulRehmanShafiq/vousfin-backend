'use strict';
const { resolveSlabs, SALARY_TAX_SLABS } = require('../../../config/payrollTaxSlabs');

describe('payroll tax slabs', () => {
  it('has the current tax year configured with ascending brackets', () => {
    const slabs = resolveSlabs('2025-26');
    expect(Array.isArray(slabs)).toBe(true);
    expect(slabs.length).toBeGreaterThan(1);
    // first bracket is the tax-free band (rate 0)
    expect(slabs[0]).toMatchObject({ rate: 0 });
    // upTo strictly ascends, last bracket is open-ended
    for (let i = 1; i < slabs.length; i++) {
      const prev = slabs[i - 1].upTo;
      expect(slabs[i].upTo === Infinity || slabs[i].upTo > prev).toBe(true);
    }
  });

  it('throws a clear error for an unconfigured year', () => {
    expect(() => resolveSlabs('2099-00')).toThrow(/not configured/i);
  });
});

'use strict';

const { fiscalYearStart } = require('../../../utils/fiscalYearStart');

describe('fiscalYearStart', () => {
  it('returns the most recent July 1 for a July fiscal year (PK tax year)', () => {
    // asOf June 2026 is BEFORE July → the year started last July
    const d = fiscalYearStart(new Date(2026, 5, 14), 7); // 14 Jun 2026
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(6);  // July (0-indexed)
    expect(d.getDate()).toBe(1);
  });

  it('rolls to this July once the fiscal month has begun', () => {
    const d = fiscalYearStart(new Date(2026, 7, 10), 7); // 10 Aug 2026
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6);
  });

  it('treats the first day of the fiscal month as in-year', () => {
    const d = fiscalYearStart(new Date(2026, 6, 1), 7); // 1 Jul 2026
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6);
  });

  it('handles a January (calendar) fiscal year', () => {
    const d = fiscalYearStart(new Date(2026, 5, 14), 1);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1);
  });

  it('defaults to January when startMonth is missing or invalid', () => {
    expect(fiscalYearStart(new Date(2026, 5, 14)).getMonth()).toBe(0);
    expect(fiscalYearStart(new Date(2026, 5, 14), 0).getMonth()).toBe(0);
    expect(fiscalYearStart(new Date(2026, 5, 14), 13).getMonth()).toBe(0);
  });
});

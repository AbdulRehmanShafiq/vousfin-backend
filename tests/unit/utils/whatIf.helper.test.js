'use strict';
const { parseWhatIf, projectAffordability } = require('../../../utils/whatIf.helper');

describe('parseWhatIf', () => {
  it('parses a hiring question with an explicit salary', () => {
    const r = parseWhatIf('Can I afford to hire 2 people at Rs 60,000 each?');
    expect(r.kind).toBe('hire');
    expect(r.count).toBe(2);
    expect(r.perUnit).toBe(60000);
    expect(r.monthlyDelta).toBe(120000);
  });

  it('parses a hiring question without a salary (uses count, delta unknown)', () => {
    const r = parseWhatIf('can I afford to hire 3 people');
    expect(r.kind).toBe('hire');
    expect(r.count).toBe(3);
    expect(r.perUnit).toBeNull();
  });

  it('parses a recurring spend question', () => {
    const r = parseWhatIf('what if I spend 50000 a month on marketing');
    expect(r.kind).toBe('spend');
    expect(r.monthlyDelta).toBe(50000);
  });

  it('returns unknown for questions it cannot ground', () => {
    expect(parseWhatIf('should I change my logo?').kind).toBe('unknown');
    expect(parseWhatIf('').kind).toBe('unknown');
  });
});

describe('projectAffordability', () => {
  const base = { cashBalance: 1200000, monthlyBurn: 200000 };
  it('computes runway before and after the added monthly cost', () => {
    const r = projectAffordability(base, 100000);
    expect(r.runwayBefore).toBe(6);   // 1.2M / 200k
    expect(r.runwayAfter).toBe(4);    // 1.2M / 300k
    expect(r.affordable).toBe(false); // < 6-month comfort floor
  });
  it('flags affordable when runway stays healthy', () => {
    const r = projectAffordability({ cashBalance: 6000000, monthlyBurn: 200000 }, 100000);
    expect(r.affordable).toBe(true); // 6M/300k = 20 months
  });
  it('handles unknown burn/cash without dividing by zero', () => {
    const r = projectAffordability({ cashBalance: 0, monthlyBurn: 0 }, 100000);
    expect(r.runwayAfter).toBeNull();
    expect(r.affordable).toBe(false);
  });
});

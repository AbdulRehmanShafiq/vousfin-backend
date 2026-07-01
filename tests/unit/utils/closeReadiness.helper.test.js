'use strict';
const { scoreReadiness } = require('../../../utils/closeReadiness.helper');

const allClear = [
  { key: 'recognitions', ok: true, count: 0, weight: 2 },
  { key: 'depreciation', ok: true, count: 0, weight: 2 },
  { key: 'approvals',    ok: true, count: 0, weight: 2 },
  { key: 'bankLines',    ok: true, count: 0, weight: 1 },
  { key: 'ledger',       ok: true, count: 0, weight: 3 },
];

describe('scoreReadiness', () => {
  it('returns 100 and ready=true when every check passes', () => {
    const r = scoreReadiness(allClear);
    expect(r.score).toBe(100);
    expect(r.ready).toBe(true);
    expect(r.blockers).toHaveLength(0);
  });

  it('weights failures: a heavy check failing hurts more than a light one', () => {
    const heavyFail = scoreReadiness(allClear.map(c => c.key === 'ledger' ? { ...c, ok: false, count: 1 } : c));
    const lightFail = scoreReadiness(allClear.map(c => c.key === 'bankLines' ? { ...c, ok: false, count: 3 } : c));
    expect(heavyFail.score).toBeLessThan(lightFail.score);
    expect(heavyFail.ready).toBe(false);
    expect(heavyFail.blockers.map(b => b.key)).toContain('ledger');
  });

  it('score is the weighted percentage of passing checks', () => {
    // weights: 2+2+2+1+3 = 10; failing the two weight-2 checks → 6/10 = 60
    const r = scoreReadiness(allClear.map(c =>
      (c.key === 'recognitions' || c.key === 'approvals') ? { ...c, ok: false, count: 2 } : c));
    expect(r.score).toBe(60);
  });

  it('handles an empty checklist without dividing by zero', () => {
    const r = scoreReadiness([]);
    expect(r.score).toBe(0);
    expect(r.ready).toBe(false);
  });
});

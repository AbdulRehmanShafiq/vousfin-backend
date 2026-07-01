'use strict';
const { computeStpScorecard } = require('../../../utils/stpMetrics.helper');

describe('computeStpScorecard', () => {
  it('computes per-capability rates and a composite score', () => {
    const s = computeStpScorecard({
      posting:        { total: 100, automated: 30 },
      matching:       { total: 20,  automated: 15 },
      reconciliation: { total: 50,  automated: 40 },
      categorization: { total: 40,  automated: 36 },
    });
    expect(s.posting.rate).toBe(0.3);
    expect(s.matching.rate).toBe(0.75);
    expect(s.reconciliation.rate).toBe(0.8);
    expect(s.categorization.rate).toBe(0.9);
    // composite = mean of capabilities WITH activity
    expect(s.stpScore).toBe(0.6875);
  });

  it('excludes capabilities with no activity from the composite (no false zeros)', () => {
    const s = computeStpScorecard({
      posting:        { total: 100, automated: 50 },
      matching:       { total: 0,   automated: 0 },
      reconciliation: { total: 0,   automated: 0 },
      categorization: { total: 0,   automated: 0 },
    });
    expect(s.posting.rate).toBe(0.5);
    expect(s.matching.rate).toBeNull();   // no signal ≠ 0% automated
    expect(s.stpScore).toBe(0.5);
  });

  it('returns a null composite when there is no activity at all', () => {
    const s = computeStpScorecard({});
    expect(s.stpScore).toBeNull();
    expect(s.posting.rate).toBeNull();
  });

  it('never lets automated exceed total (defensive clamp)', () => {
    const s = computeStpScorecard({ posting: { total: 10, automated: 15 } });
    expect(s.posting.rate).toBe(1);
  });
});

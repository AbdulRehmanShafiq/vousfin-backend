'use strict';
const { buildRecommendations } = require('../../../utils/advisor.helper');

describe('buildRecommendations', () => {
  it('turns a liquidity alert into the top-ranked critical recommendation', () => {
    const recs = buildRecommendations({
      liquidityAlerts: [{ weekStart: '2026-07-06', projectedClosing: -45000 }],
      receivableAging: { over60Total: 20000, over60Count: 2 },
    });
    expect(recs[0].id).toBe('cash_low_week');
    expect(recs[0].severity).toBe('critical');
    expect(recs[0].why).toContain('45,000');
    expect(recs[0].action.link).toBeTruthy();
  });

  it('recommends chasing receivables overdue past 60 days, citing the amount', () => {
    const recs = buildRecommendations({ receivableAging: { over60Total: 150000, over60Count: 3 } });
    const r = recs.find(x => x.id === 'chase_overdue_receivables');
    expect(r).toBeDefined();
    expect(r.severity).toBe('high');
    expect(r.why).toContain('150,000');
    expect(r.why).toContain('3');
  });

  it('flags a weak health score and low automation as lighter suggestions', () => {
    const recs = buildRecommendations({
      healthScore: { score: 45 },
      stp: { stpScore: 0.2 },
    });
    const health = recs.find(x => x.id === 'weak_health');
    const stp = recs.find(x => x.id === 'raise_automation');
    expect(health.severity).toBe('medium');
    expect(health.why).toContain('45');
    expect(stp.severity).toBe('info');
  });

  it('ranks by severity: critical > high > medium > info', () => {
    const recs = buildRecommendations({
      liquidityAlerts: [{ weekStart: '2026-07-06', projectedClosing: -1 }],
      receivableAging: { over60Total: 99, over60Count: 1 },
      healthScore: { score: 30 },
      stp: { stpScore: 0.1 },
    });
    const sevs = recs.map(r => r.severity);
    expect(sevs).toEqual([...sevs].sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, info: 3 };
      return order[a] - order[b];
    }));
  });

  it('returns an empty list when everything is healthy (no noise)', () => {
    const recs = buildRecommendations({
      liquidityAlerts: [],
      receivableAging: { over60Total: 0, over60Count: 0 },
      healthScore: { score: 85 },
      stp: { stpScore: 0.9 },
    });
    expect(recs).toEqual([]);
  });

  it('tolerates missing signals entirely', () => {
    expect(buildRecommendations({})).toEqual([]);
    expect(buildRecommendations()).toEqual([]);
  });
});

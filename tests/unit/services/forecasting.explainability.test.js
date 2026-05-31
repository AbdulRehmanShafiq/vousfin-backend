/**
 * tests/unit/services/forecasting.explainability.test.js
 *
 * Forecast Platform — F7. Attribution (ensemble decomposition + exact linear
 * contributions) and the what-if scenario engine.
 */
'use strict';

const attr = require('../../../services/forecasting/explainability/attribution');
const scen = require('../../../services/forecasting/explainability/scenario');
const baselines = require('../../../services/forecasting/baselines');

describe('ensemble attribution', () => {
  it('splits the point forecast into member contributions summing to the total', () => {
    const weights = { holtWinters: 0.5, drift: 0.3, seasonalNaive: 0.2 };
    const memberPoint = { holtWinters: 100, drift: 120, seasonalNaive: 80 };
    const a = attr.ensembleAttribution(weights, memberPoint);
    // total = 0.5*100 + 0.3*120 + 0.2*80 = 50 + 36 + 16 = 102
    expect(a.total).toBe(102);
    expect(a.members[0].name).toBe('holtWinters');      // largest contribution
    expect(a.members.reduce((s, m) => s + m.pct, 0)).toBeGreaterThan(95);
  });
});

describe('linear (AR) contributions — exact Shapley for a linear model', () => {
  it('decomposes coef·feature with a base term', () => {
    // y = 5 + 0.8*lag1 + 0.2*lag2 ; features [100, 50] → 5 + 80 + 10 = 95
    const r = attr.linearContributions([5, 0.8, 0.2], [100, 50], ['revenue t-1', 'revenue t-2']);
    expect(r.base).toBe(5);
    expect(r.total).toBe(95);
    expect(r.drivers[0].name).toBe('revenue t-1');      // 80 > 10
    expect(r.drivers[0].contribution).toBe(80);
    expect(r.drivers[0].direction).toBe('up');
  });
});

describe('scenario engine', () => {
  const series = [100, 110, 120, 130, 140, 150, 160, 170];
  const build = () => (train, h) => baselines.drift(train, h);

  it('applyShock rescales a forecast', () => {
    expect(scen.applyShock([100, 200], { multiplier: 1.1 })).toEqual([110, 220]);
  });

  it('whatIf refits on a transformed series (a +20% revenue scenario lifts the forecast)', () => {
    const base = scen.whatIf(series, build, (v) => v, 3);
    const up = scen.whatIf(series, build, (v) => v * 1.2, 3);
    expect(up[0]).toBeGreaterThan(base[0]);
  });

  it('compare reports per-step deltas', () => {
    const cmp = scen.compare([100, 100], [110, 90]);
    expect(cmp[0].deltaPct).toBe(10);
    expect(cmp[1].delta).toBe(-10);
  });

  it('sweep returns a forecast per multiplier', () => {
    const grid = scen.sweep(series, build, [0.9, 1.0, 1.1], 2);
    expect(grid).toHaveLength(3);
    expect(grid[2].forecast[0]).toBeGreaterThan(grid[0].forecast[0]);
  });
});

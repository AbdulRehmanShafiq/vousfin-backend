/**
 * tests/unit/services/forecasting.featureEngineering.test.js
 *
 * Feature Engineering Framework — causal transforms (leakage-safe) + selection
 * (mutual information, PCA, ranking).
 */
'use strict';

const t = require('../../../services/forecasting/featureEngineering/transforms');
const sel = require('../../../services/forecasting/featureEngineering/selection');

describe('causal transforms (leakage-safe)', () => {
  const s = [10, 20, 30, 40, 50];

  it('lag returns nulls before history exists and never looks ahead', () => {
    expect(t.lag(s, 1)).toEqual([null, 10, 20, 30, 40]);
    expect(t.lag(s, 2)).toEqual([null, null, 10, 20, 30]);
  });

  it('rolling mean/std are trailing (inclusive of t)', () => {
    expect(t.rollingMean(s, 3)).toEqual([10, 15, 20, 30, 40]); // last = mean(30,40,50)
    expect(t.rollingStd(s, 2)[0]).toBeNull();                   // needs ≥2
  });

  it('rolling z-score standardizes against the trailing window', () => {
    const z = t.rollingZScore([1, 1, 1, 1, 10], 4);
    expect(z[4]).toBeGreaterThan(1);                            // spike stands out
  });

  it('EWMA is causal and smooths', () => {
    const e = t.ewma([10, 20, 30], { span: 2 });
    expect(e[0]).toBe(10);
    expect(e[2]).toBeGreaterThan(20);
    expect(e[2]).toBeLessThan(30);
  });

  it('diff and pctChange', () => {
    expect(t.diff(s, 1)).toEqual([null, 10, 10, 10, 10]);
    expect(t.pctChange(s, 1)[1]).toBe(100);                     // (20-10)/10
  });

  it('Fourier terms are bounded and periodic', () => {
    const f0 = t.fourierTerms(0, 12, 2);
    expect(f0.fourier_sin_12_1).toBe(0);
    expect(f0.fourier_cos_12_1).toBe(1);
    const f12 = t.fourierTerms(12, 12, 1);                      // one full period later
    expect(f12.fourier_cos_12_1).toBeCloseTo(1, 3);
  });
});

describe('selection', () => {
  it('mutual information is high for a dependent pair, ~0 for independent', () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8];
    const yDep = x.map((v) => v * 2);
    const yInd = [5, 1, 8, 2, 7, 3, 6, 4];
    expect(sel.mutualInformation(x, yDep, 4)).toBeGreaterThan(sel.mutualInformation(x, yInd, 4));
  });

  it('pearson recovers a perfect linear relationship', () => {
    expect(sel.pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 3);
  });

  it('PCA returns components with explained variance summing toward 1', () => {
    const m = [[1, 2], [2, 4], [3, 6], [4, 8], [5, 10]]; // perfectly collinear → 1 component
    const p = sel.pca(m, 2);
    expect(p.components.length).toBe(2);
    expect(p.explainedVariance[0]).toBeGreaterThan(0.95);
  });

  it('selectFeatures ranks the most informative feature first', () => {
    const target = [1, 2, 3, 4, 5, 6];
    const cols = { strong: [1, 2, 3, 4, 5, 6], weak: [3, 1, 4, 1, 5, 9] };
    const { selected } = sel.selectFeatures(cols, target, { method: 'mi', topK: 2 });
    expect(selected[0].name).toBe('strong');
  });
});

'use strict';
const { scoreClassification, compareToBaseline } = require('../../../utils/evalMetrics');

describe('scoreClassification', () => {
  it('computes accuracy over a key, case-insensitive', () => {
    const preds = [{ type: 'Expense' }, { type: 'income' }, { type: 'Transfer' }];
    const gold  = [{ type: 'expense' }, { type: 'Income' }, { type: 'Expense' }];
    const r = scoreClassification(preds, gold, 'type');
    expect(r.total).toBe(3);
    expect(r.correct).toBe(2);
    expect(r.accuracy).toBe(0.6667);
  });
  it('handles empty input without dividing by zero', () => {
    expect(scoreClassification([], [], 'type')).toEqual({ total: 0, correct: 0, accuracy: 0 });
  });
});

describe('compareToBaseline', () => {
  it('passes when current meets or beats baseline', () => {
    const r = compareToBaseline({ accuracy: 0.9 }, { accuracy: 0.85 });
    expect(r.pass).toBe(true);
    expect(r.regressions).toHaveLength(0);
  });
  it('fails and lists regressions when current is below baseline', () => {
    const r = compareToBaseline({ accuracy: 0.80 }, { accuracy: 0.85 });
    expect(r.pass).toBe(false);
    expect(r.regressions[0]).toEqual(expect.objectContaining({ metric: 'accuracy', current: 0.80, baseline: 0.85 }));
  });
  it('honours a tolerance band', () => {
    const r = compareToBaseline({ accuracy: 0.84 }, { accuracy: 0.85 }, { tolerance: 0.02 });
    expect(r.pass).toBe(true);
  });
});

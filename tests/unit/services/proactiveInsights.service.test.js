/**
 * tests/unit/services/proactiveInsights.service.test.js
 *
 * H6 — the unified "Needs attention" feed. Tests the PURE merge/rank/dedupe
 * and the action-routing helpers.
 */
'use strict';

const { _pure } = require('../../../services/proactiveInsights.service');
const { normalizeLevel, actionFor, normalizeItem, dedupeAndRank, countBy, buildAutoPostedItem } = _pure;

describe('normalizeLevel', () => {
  it('passes through known levels', () => {
    expect(normalizeLevel('critical')).toBe('critical');
    expect(normalizeLevel('warning')).toBe('warning');
    expect(normalizeLevel('info')).toBe('info');
  });
  it('maps synonyms and unknowns', () => {
    expect(normalizeLevel('danger')).toBe('critical');
    expect(normalizeLevel('high')).toBe('critical');
    expect(normalizeLevel('medium')).toBe('warning');
    expect(normalizeLevel('whatever')).toBe('info');
    expect(normalizeLevel(undefined)).toBe('info');
  });
});

describe('actionFor (keyword → route)', () => {
  it('routes by keyword', () => {
    expect(actionFor({ title: 'Unusual transactions detected' }).actionTo).toBe('/ai-analyst/anomalies');
    expect(actionFor({ title: 'Overdue receivables' }).actionTo).toBe('/sales/receivables');
    expect(actionFor({ message: 'vendors bill due' }).actionTo).toBe('/purchases/payables');
    expect(actionFor({ title: 'Unremitted GST' }).actionTo).toBe('/financial-reports');
    expect(actionFor({ title: 'Projected cash shortfall' }).actionTo).toBe('/ai/forecast');
    expect(actionFor({ title: 'Revenue projected to decline' }).actionTo).toBe('/ai/forecast');
  });
  it('returns {} when nothing matches', () => {
    expect(actionFor({ title: 'Something neutral' })).toEqual({});
  });
});

describe('normalizeItem', () => {
  it('builds a normalized item with id, level, action', () => {
    const it = normalizeItem({ level: 'critical', title: 'Projected cash shortfall', message: 'Runs out in ~2 months' }, 'forecast');
    expect(it.level).toBe('critical');
    expect(it.source).toBe('forecast');
    expect(it.actionTo).toBe('/ai/forecast');
    expect(it.id).toBeTruthy();
  });
  it('does not duplicate message when equal to title', () => {
    const it = normalizeItem({ level: 'info', title: 'Same', message: 'Same' }, 'finance');
    expect(it.message).toBe('');
  });
});

describe('dedupeAndRank', () => {
  it('keeps the most severe of duplicate titles', () => {
    const out = dedupeAndRank([
      { title: 'Cash low', level: 'warning' },
      { title: 'cash low', level: 'critical' }, // same title, higher severity
      { title: 'Tax due', level: 'info' },
    ]);
    expect(out).toHaveLength(2);
    const cash = out.find((i) => i.title.toLowerCase() === 'cash low');
    expect(cash.level).toBe('critical');
  });
  it('ranks critical → warning → info', () => {
    const out = dedupeAndRank([
      { title: 'c', level: 'info' },
      { title: 'a', level: 'critical' },
      { title: 'b', level: 'warning' },
    ]);
    expect(out.map((i) => i.level)).toEqual(['critical', 'warning', 'info']);
  });
});

describe('countBy', () => {
  it('counts by level + total', () => {
    const c = countBy([
      { level: 'critical' }, { level: 'warning' }, { level: 'warning' }, { level: 'info' },
    ]);
    expect(c).toEqual({ critical: 1, warning: 2, info: 1, total: 4 });
  });
});

// H6 + Phase 3 auto-post visibility — recently AI-auto-posted entries are
// surfaced as a passive, low-urgency review item (not a blocking action).
describe('buildAutoPostedItem', () => {
  it('returns null when nothing was auto-posted', () => {
    expect(buildAutoPostedItem(0)).toBeNull();
  });

  it('builds a low-urgency info item summarizing the count', () => {
    const item = buildAutoPostedItem(3);
    expect(item.level).toBe('info');
    expect(item.title).toMatch(/auto-posted/i);
    expect(item.message).toMatch(/3/);
    expect(item.actionTo).toBe('/transactions?filter=ai_auto_posted');
  });

  it('singularizes the message for exactly one', () => {
    const item = buildAutoPostedItem(1);
    expect(item.message).not.toMatch(/1 transactions/i);
  });
});

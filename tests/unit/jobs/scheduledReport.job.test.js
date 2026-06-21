const { computeNextRun } = require('../../../jobs/scheduledReport.job');

describe('computeNextRun', () => {
  test('daily → next day at the configured hour', () => {
    const from = new Date('2026-06-21T10:00:00Z');
    const next = computeNextRun({ frequency: 'daily', hour: 6 }, from);
    expect(next.getUTCDate()).toBe(22);
    expect(next.getUTCHours()).toBe(6);
  });

  test('weekly → next configured weekday', () => {
    const from = new Date('2026-06-21T10:00:00Z'); // Sunday (day 0)
    const next = computeNextRun({ frequency: 'weekly', dayOfWeek: 3, hour: 6 }, from); // Wednesday
    expect(next.getUTCDay()).toBe(3);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });

  test('monthly → configured day of next month', () => {
    const from = new Date('2026-06-21T10:00:00Z');
    const next = computeNextRun({ frequency: 'monthly', dayOfMonth: 1, hour: 6 }, from);
    expect(next.getUTCDate()).toBe(1);
    expect(next.getUTCMonth()).toBe(6); // July (0-indexed)
  });
});

const { computeNextRun, reportWindowFor } = require('../../../jobs/scheduledReport.job');

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

describe('reportWindowFor', () => {
  // Fixed reference: 2026-06-21T10:00:00Z (a Sunday)
  const NOW = new Date('2026-06-21T10:00:00Z');

  test('daily → previous full day (2026-06-20 UTC)', () => {
    const { startDate, endDate } = reportWindowFor('daily', NOW);
    expect(startDate.toISOString()).toBe('2026-06-20T00:00:00.000Z');
    expect(endDate.toISOString()).toBe('2026-06-20T23:59:59.999Z');
  });

  test('weekly → previous 7 days: 2026-06-14T00:00Z to 2026-06-20T23:59:59.999Z', () => {
    const { startDate, endDate } = reportWindowFor('weekly', NOW);
    expect(startDate.toISOString()).toBe('2026-06-14T00:00:00.000Z');
    expect(endDate.toISOString()).toBe('2026-06-20T23:59:59.999Z');
  });

  test('monthly → previous full calendar month: 2026-05-01T00:00Z to 2026-05-31T23:59:59.999Z', () => {
    const { startDate, endDate } = reportWindowFor('monthly', NOW);
    expect(startDate.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(endDate.toISOString()).toBe('2026-05-31T23:59:59.999Z');
  });
});

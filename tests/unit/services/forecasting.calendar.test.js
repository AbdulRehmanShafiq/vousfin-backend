/**
 * tests/unit/services/forecasting.calendar.test.js
 *
 * Forecast Platform — B2. Calendar/seasonality regressors + pipeline integration.
 */
'use strict';

const cal = require('../../../services/forecasting/featureEngineering/calendar');
const { engineer } = require('../../../services/forecasting/featureEngineering/pipeline');

describe('calendar features (causal)', () => {
  it('flags month/quarter/year end + payroll window', () => {
    const dec31 = cal.calendarFeatures('2026-12-31');
    expect(dec31.is_month_end).toBe(1);
    expect(dec31.is_quarter_end).toBe(1);
    expect(dec31.is_year_end).toBe(1);
    expect(dec31.payroll_window).toBe(1);

    const mid = cal.calendarFeatures('2026-06-15');
    expect(mid.is_month_end).toBe(0);
    expect(mid.payroll_window).toBe(1); // mid-month payroll
  });

  it('detects fixed-date holidays', () => {
    const ny = cal.calendarFeatures('2026-01-01');
    expect(ny.holiday).toBe(1);
    expect(ny.holiday_name).toMatch(/New Year/);
    expect(cal.calendarFeatures('2026-01-02').holiday).toBe(0);
  });
});

describe('seasonal strength + period detection', () => {
  it('finds strong seasonality in a clearly seasonal series', () => {
    const seasonal = [];
    for (let i = 0; i < 24; i++) seasonal.push([10, 30, 20][i % 3]); // period-3 cycle
    expect(cal.seasonalStrength(seasonal, 3)).toBeGreaterThan(0.8);
  });
  it('reports near-zero strength for a flat/noisy series', () => {
    expect(cal.seasonalStrength([5, 5, 5, 5, 5, 5], 3)).toBeLessThan(0.1);
  });
  it('detectPeriod recovers the dominant cycle', () => {
    const s = [];
    for (let i = 0; i < 24; i++) s.push([100, 50, 80, 120][i % 4]);
    expect(cal.detectPeriod(s, [12, 4, 3, 2]).period).toBe(4);
  });
});

describe('pipeline integration', () => {
  it('adds calendar features to the engineered matrix', () => {
    const rows = [
      { periodKey: '2026-03', periodStart: new Date(Date.UTC(2026, 2, 1)), periodEnd: new Date(Date.UTC(2026, 3, 1)), revenue: 1000, expenses: 600, profit: 400, netCashFlow: 400 },
      { periodKey: '2026-12', periodStart: new Date(Date.UTC(2026, 11, 1)), periodEnd: new Date(Date.UTC(2027, 0, 1)), revenue: 1200, expenses: 700, profit: 500, netCashFlow: 500 },
    ];
    const { features } = engineer(rows);
    expect(features[0].is_quarter_end_month).toBe(1);  // March
    expect(features[1].is_year_end_month).toBe(1);      // December
    expect(features[1].holiday_count).toBeGreaterThanOrEqual(1); // Christmas in Dec
  });
});

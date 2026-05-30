/**
 * tests/unit/services/forecastPlatform.engines.test.js
 *
 * Forecast Platform — Foundation (F1). Pure engines:
 * tenant isolation, timezone/granularity bucketing, currency normalization,
 * and the data-validation framework (incl. the leakage guard).
 */
'use strict';

jest.mock('../../../services/fx.service', () => ({
  getBaseCurrency: jest.fn().mockResolvedValue('USD'),
  convert: jest.fn(),
}));

const tz = require('../../../services/forecasting/platform/timezone');
const { assertTenant, scopeFilter, assertSameTenant } = require('../../../services/forecasting/platform/tenantScope');
const dv = require('../../../services/forecasting/platform/dataValidation');
const CurrencyNormalizer = require('../../../services/forecasting/platform/currencyNormalizer');
const fxService = require('../../../services/fx.service');

const BIZ = '507f1f77bcf86cd799439060';

beforeEach(() => jest.clearAllMocks());

describe('timezone / granularity engine', () => {
  it('buckets each granularity correctly', () => {
    expect(tz.periodKey('2026-01-08T10:00:00Z', 'daily')).toBe('2026-01-08');
    expect(tz.periodKey('2026-01-08T10:00:00Z', 'weekly')).toBe('2026-W02');
    expect(tz.periodKey('2026-01-08T10:00:00Z', 'monthly')).toBe('2026-01');
    expect(tz.periodKey('2026-05-30T10:00:00Z', 'quarterly')).toBe('2026-Q2');
  });
  it('applies tz offset before bucketing (late-night local day)', () => {
    // 2026-01-08 23:30 UTC, +120min → 2026-01-09 01:30 local → daily 2026-01-09
    expect(tz.periodKey('2026-01-08T23:30:00Z', 'daily', 120)).toBe('2026-01-09');
  });
  it('enumerates a contiguous period axis (gap-fill source)', () => {
    expect(tz.enumeratePeriods('2026-01-15', '2026-03-10', 'monthly')).toEqual(['2026-01', '2026-02', '2026-03']);
  });
});

describe('tenant isolation layer', () => {
  it('rejects a missing/invalid businessId', () => {
    expect(() => assertTenant(null)).toThrow();
    expect(() => assertTenant('nope')).toThrow();
  });
  it('forces businessId into a scoped filter (cannot be overridden)', () => {
    const f = scopeFilter(BIZ, { businessId: 'evil', state: 'x' });
    expect(String(f.businessId)).toBe(BIZ);
    expect(f.state).toBe('x');
  });
  it('blocks cross-tenant access', () => {
    expect(() => assertSameTenant(BIZ, '507f1f77bcf86cd799439061')).toThrow(/cross-tenant/);
    expect(() => assertSameTenant(BIZ, BIZ)).not.toThrow();
  });
});

describe('data validation framework', () => {
  const good = [
    { periodKey: '2026-01', periodStart: new Date('2026-01-01'), baseCurrency: 'USD', revenue: 100, expenses: 60 },
    { periodKey: '2026-02', periodStart: new Date('2026-02-01'), baseCurrency: 'USD', revenue: 120, expenses: 70 },
  ];
  it('passes a clean dataset', () => {
    expect(dv.validateDataset(good, { asOf: new Date('2026-03-01') }).passed).toBe(true);
  });
  it('fails on future-dated rows (LEAKAGE guard)', () => {
    const v = dv.validateDataset(good, { asOf: new Date('2026-01-15') });
    expect(v.passed).toBe(false);
    expect(v.errors).toContain('no_future_dates');
  });
  it('fails on a non-monotonic period axis', () => {
    const bad = [good[1], good[0]]; // out of order
    expect(dv.validateDataset(bad, { asOf: new Date('2026-03-01') }).errors).toContain('monotonic_periods');
  });
  it('flags missing base currency', () => {
    const v = dv.validateDataset([{ periodKey: '2026-01', periodStart: new Date('2026-01-01'), revenue: 1, expenses: 1 }], { asOf: new Date('2026-03-01') });
    expect(v.passed).toBe(false);
    expect(v.errors).toContain('currency_stamped');
  });
});

describe('currency normalization engine', () => {
  it('passes through base-currency amounts without an FX call', async () => {
    const n = new CurrencyNormalizer(BIZ, 'USD');
    expect(await n.toBase(100, 'USD', new Date())).toBe(100);
    expect(fxService.convert).not.toHaveBeenCalled();
  });
  it('converts foreign amounts and caches the monthly rate', async () => {
    fxService.convert.mockResolvedValue(280); // 1 USD → 280 PKR equivalent
    const n = new CurrencyNormalizer(BIZ, 'USD');
    const a = await n.toBase(280, 'PKR', new Date('2026-01-10'));
    const b = await n.toBase(560, 'PKR', new Date('2026-01-20')); // same month → cached rate
    expect(a).toBe(280);
    expect(b).toBe(560);
    expect(fxService.convert).toHaveBeenCalledTimes(1); // cached second call
  });
  it('falls back to 1:1 when FX fails (never throws)', async () => {
    fxService.convert.mockRejectedValue(new Error('no rate'));
    const n = new CurrencyNormalizer(BIZ, 'USD');
    expect(await n.toBase(100, 'EUR', new Date())).toBe(100);
  });
});

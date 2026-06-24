// tests/unit/services/fixedAsset.service.test.js
'use strict';
jest.mock('../../../models/FixedAsset.model');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../services/ledgerPosting.service');

const fixedAssetService = require('../../../services/fixedAsset.service');

describe('fixedAsset.computeDepreciationSchedule', () => {
  test('straight-line spreads (cost - salvage) evenly and ends at salvage value', () => {
    const rows = fixedAssetService.computeDepreciationSchedule({
      acquisitionCost: 100000, salvageValue: 10000, usefulLifeYears: 5, depreciationMethod: 'straight_line',
    });
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ year: 1, depreciation: 18000, accumulated: 18000, bookValue: 82000 });
    expect(rows[4]).toMatchObject({ year: 5, depreciation: 18000, accumulated: 90000, bookValue: 10000 });
  });

  test('declining-balance (double) depreciates on book value and never drops below salvage', () => {
    const rows = fixedAssetService.computeDepreciationSchedule({
      acquisitionCost: 100000, salvageValue: 10000, usefulLifeYears: 5, depreciationMethod: 'declining_balance',
    });
    expect(rows[0].depreciation).toBe(40000); // 100000 * (2/5)
    expect(rows[1].depreciation).toBe(24000); // 60000 * 0.4
    expect(rows[4].bookValue).toBe(10000);    // capped at salvage
    const total = rows.reduce((s, r) => s + r.depreciation, 0);
    expect(total).toBeCloseTo(90000, 2);      // total depreciable = cost - salvage
  });

  test('a fully-salvage asset (cost == salvage) depreciates nothing', () => {
    const rows = fixedAssetService.computeDepreciationSchedule({
      acquisitionCost: 5000, salvageValue: 5000, usefulLifeYears: 3, depreciationMethod: 'straight_line',
    });
    expect(rows.every((r) => r.depreciation === 0)).toBe(true);
  });
});

describe('fixedAsset.computeDisposal', () => {
  test('gain when proceeds exceed net book value', () => {
    // cost 100000, accumulated 60000 -> NBV 40000; proceeds 50000 -> gain 10000
    const d = fixedAssetService.computeDisposal({ acquisitionCost: 100000, accumulatedDepreciation: 60000 }, 50000);
    expect(d).toMatchObject({ netBookValue: 40000, gain: 10000, loss: 0 });
  });

  test('loss when proceeds are below net book value', () => {
    const d = fixedAssetService.computeDisposal({ acquisitionCost: 100000, accumulatedDepreciation: 60000 }, 25000);
    expect(d).toMatchObject({ netBookValue: 40000, gain: 0, loss: 15000 });
  });
});

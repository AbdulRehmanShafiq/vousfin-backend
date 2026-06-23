// tests/unit/services/leaseAccounting.service.test.js — FR-10.2
'use strict';

jest.mock('../../../models/Lease.model', () => ({
  create: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
}));
jest.mock('../../../services/ledgerPosting.service', () => ({ postCompoundJournal: jest.fn() }));
jest.mock('../../../repositories/account.repository', () => ({ findAll: jest.fn().mockResolvedValue({ data: [] }) }));

const leaseService = require('../../../services/leaseAccounting.service');

beforeEach(() => jest.clearAllMocks());

describe('computeAmortizationSchedule', () => {
  const lease = {
    leaseTerm: 12,
    monthlyPayment: 10000,
    discountRate: 0.12, // 12% annual
    commencementDate: new Date('2026-01-01'),
    assetName: 'Test Asset',
  };

  it('produces a schedule with exactly leaseTerm rows', () => {
    const { schedule } = leaseService.computeAmortizationSchedule(lease);
    expect(schedule).toHaveLength(12);
  });

  it('computes present value correctly for a 12-month 10000 PKR lease at 12% annual', () => {
    const { initialLiability, initialRouAsset } = leaseService.computeAmortizationSchedule(lease);
    // PV of annuity: Σ 10000 / (1.12)^(n/12) for n=1..12
    // monthlyRate = (1.12)^(1/12) - 1 ≈ 0.009489
    // Expected PV ≈ 112551 (approx)
    expect(initialLiability).toBeGreaterThan(110000);
    expect(initialLiability).toBeLessThan(115000);
    expect(initialRouAsset).toBe(initialLiability);
  });

  it('period 1: interest = openingLiability * monthlyRate', () => {
    const { initialLiability, schedule } = leaseService.computeAmortizationSchedule(lease);
    const monthlyRate = Math.pow(1.12, 1 / 12) - 1;
    const expectedInterest = Math.round(initialLiability * monthlyRate * 100) / 100;
    expect(schedule[0].interestCharge).toBeCloseTo(expectedInterest, 1);
  });

  it('period 1: principalRepayment = payment - interestCharge', () => {
    const { schedule } = leaseService.computeAmortizationSchedule(lease);
    const row = schedule[0];
    expect(row.principalRepayment).toBeCloseTo(row.payment - row.interestCharge, 1);
  });

  it('closing liability of period N equals opening liability of period N+1', () => {
    const { schedule } = leaseService.computeAmortizationSchedule(lease);
    for (let i = 0; i < schedule.length - 1; i++) {
      expect(schedule[i].closingLiability).toBeCloseTo(schedule[i + 1].openingLiability, 0);
    }
  });

  it('ROU depreciation is consistent across all periods', () => {
    const { initialRouAsset, schedule } = leaseService.computeAmortizationSchedule(lease);
    const expectedDep = Math.round((initialRouAsset / 12) * 100) / 100;
    for (const row of schedule) {
      expect(row.rouDepreciation).toBeCloseTo(expectedDep, 1);
    }
  });
});

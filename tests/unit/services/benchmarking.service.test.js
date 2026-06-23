// tests/unit/services/benchmarking.service.test.js
// TDD — Phase 8 FR-09.3 Industry Benchmarking
'use strict';

// All mocks declared at top level so jest hoists them
jest.mock('../../../repositories/account.repository');
jest.mock('../../../models/Business.model');
jest.mock('../../../models/JournalEntry.model');

const accountRepo  = require('../../../repositories/account.repository');
const Business     = require('../../../models/Business.model');
const JournalEntry = require('../../../models/JournalEntry.model');
const benchmarkingService = require('../../../services/benchmarking.service');

const BIZ_ID = '507f1f77bcf86cd799439011';

beforeEach(() => jest.clearAllMocks());

describe('benchmarking.service', () => {
  describe('getSectorForBusiness', () => {
    it('maps Technology businessType to technology sector', async () => {
      Business.findById.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ businessType: 'IT Services / Software Development' }),
      });
      const sector = await benchmarkingService.getSectorForBusiness(BIZ_ID);
      expect(sector).toBe('technology');
    });

    it('maps Retail Store to retail', async () => {
      Business.findById.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ businessType: 'Retail Store' }),
      });
      const sector = await benchmarkingService.getSectorForBusiness(BIZ_ID);
      expect(sector).toBe('retail');
    });

    it('maps Manufacturing to manufacturing', async () => {
      Business.findById.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ businessType: 'Manufacturing' }),
      });
      const sector = await benchmarkingService.getSectorForBusiness(BIZ_ID);
      expect(sector).toBe('manufacturing');
    });

    it('falls back to services for unknown type', async () => {
      Business.findById.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ businessType: 'Other' }),
      });
      const sector = await benchmarkingService.getSectorForBusiness(BIZ_ID);
      expect(sector).toBe('services');
    });

    it('falls back to services when business not found', async () => {
      Business.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
      const sector = await benchmarkingService.getSectorForBusiness(BIZ_ID);
      expect(sector).toBe('services');
    });
  });

  describe('getBusinessRatios', () => {
    it('returns null ratios (not throw) when currentLiabilities is 0 (div by zero)', async () => {
      accountRepo.findByBusiness.mockResolvedValue([
        { accountType: 'Asset', accountSubtype: 'Bank and Cash', runningBalance: 100000 },
        { accountType: 'Liability', accountSubtype: 'Current Liabilities', runningBalance: 0 },
      ]);
      JournalEntry.aggregate.mockResolvedValue([]);
      const ratios = await benchmarkingService.getBusinessRatios(BIZ_ID);
      expect(ratios.currentRatio).toBeNull();
      expect(ratios.quickRatio).toBeNull();
    });

    it('computes currentRatio correctly', async () => {
      accountRepo.findByBusiness.mockResolvedValue([
        { accountType: 'Asset', accountSubtype: 'Current Assets', runningBalance: 200000 },
        { accountType: 'Asset', accountSubtype: 'Bank and Cash', runningBalance: 50000 },
        { accountType: 'Liability', accountSubtype: 'Current Liabilities', runningBalance: 100000 },
        { accountType: 'Liability', accountSubtype: 'Non-current Liabilities', runningBalance: 50000 },
        { accountType: 'Equity', accountSubtype: 'Equity', runningBalance: 200000 },
        { accountType: 'Asset', accountSubtype: 'Non-current Assets', runningBalance: 100000 },
      ]);
      JournalEntry.aggregate.mockResolvedValue([
        { _id: 'revenue', total: 500000 },
        { _id: 'cogs', total: 300000 },
        { _id: 'expense', total: 400000 },
      ]);
      const ratios = await benchmarkingService.getBusinessRatios(BIZ_ID);
      // currentAssets = 200000 + 50000 = 250000; currentLiabilities = 100000
      expect(ratios.currentRatio).toBeCloseTo(2.5, 1);
    });

    it('does not throw when aggregate returns empty', async () => {
      accountRepo.findByBusiness.mockResolvedValue([]);
      JournalEntry.aggregate.mockResolvedValue([]);
      await expect(benchmarkingService.getBusinessRatios(BIZ_ID)).resolves.toBeDefined();
    });
  });

  describe('getBenchmark', () => {
    it('returns correct structure with direction flags', async () => {
      Business.findById.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ businessType: 'Retail Store' }),
      });
      accountRepo.findByBusiness.mockResolvedValue([
        { accountType: 'Asset', accountSubtype: 'Current Assets', runningBalance: 300000 },
        { accountType: 'Asset', accountSubtype: 'Bank and Cash', runningBalance: 50000 },
        { accountType: 'Liability', accountSubtype: 'Current Liabilities', runningBalance: 100000 },
        { accountType: 'Liability', accountSubtype: 'Non-current Liabilities', runningBalance: 50000 },
        { accountType: 'Equity', accountSubtype: 'Equity', runningBalance: 200000 },
        { accountType: 'Asset', accountSubtype: 'Non-current Assets', runningBalance: 50000 },
      ]);
      JournalEntry.aggregate.mockResolvedValue([
        { _id: 'revenue', total: 600000 },
        { _id: 'cogs', total: 200000 },
        { _id: 'expense', total: 580000 },
      ]);

      const result = await benchmarkingService.getBenchmark(BIZ_ID);

      expect(result).toHaveProperty('sector');
      expect(result).toHaveProperty('ratios');
      expect(result).toHaveProperty('overallScore');
      expect(typeof result.overallScore).toBe('number');

      const ratioKeys = ['currentRatio','quickRatio','debtToEquity','grossMargin','netMargin','returnOnAssets','assetTurnover','interestCoverage'];
      for (const k of ratioKeys) {
        expect(result.ratios).toHaveProperty(k);
        const r = result.ratios[k];
        expect(r).toHaveProperty('business');
        expect(r).toHaveProperty('benchmark');
        expect(['above','below','at','no_data']).toContain(r.direction);
      }
    });

    it('counts above-benchmark ratios correctly in overallScore', async () => {
      Business.findById.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ businessType: 'Retail Store' }),
      });
      // return no accounts — will produce null ratios
      accountRepo.findByBusiness.mockResolvedValue([]);
      JournalEntry.aggregate.mockResolvedValue([]);
      const result = await benchmarkingService.getBenchmark(BIZ_ID);
      // All null → overallScore should be 0
      expect(result.overallScore).toBe(0);
      // direction should be no_data for all nulls
      for (const r of Object.values(result.ratios)) {
        expect(r.direction).toBe('no_data');
      }
    });
  });
});

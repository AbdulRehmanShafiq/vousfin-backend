// tests/unit/services/thirteenWeekCashFlow.service.test.js
// TDD — Phase 8 FR-06.3 13-week cash flow forecast
'use strict';

jest.mock('../../../repositories/account.repository');
jest.mock('../../../models/JournalEntry.model');
jest.mock('../../../models/InvoiceSchedule.model', () => ({}));
jest.mock('../../../models/BillSchedule.model', () => ({}));

const accountRepo  = require('../../../repositories/account.repository');
const JournalEntry = require('../../../models/JournalEntry.model');
const service = require('../../../services/thirteenWeekCashFlow.service');

const BIZ_ID = '507f1f77bcf86cd799439011';

beforeEach(() => jest.clearAllMocks());

function makeAccounts(cashBalance = 500000) {
  return [
    {
      accountType: 'Asset',
      accountSubtype: 'Bank and Cash',
      accountCode: '1010',
      runningBalance: cashBalance,
    },
  ];
}

describe('thirteenWeekCashFlow.service', () => {
  describe('buildForecast', () => {
    it('returns exactly 13 weeks', async () => {
      accountRepo.findByBusiness.mockResolvedValue(makeAccounts());
      JournalEntry.aggregate.mockResolvedValue([]);
      const result = await service.buildForecast(BIZ_ID);
      expect(result.weeks).toHaveLength(13);
    });

    it('each week has the expected fields', async () => {
      accountRepo.findByBusiness.mockResolvedValue(makeAccounts());
      JournalEntry.aggregate.mockResolvedValue([]);
      const result = await service.buildForecast(BIZ_ID);
      for (const w of result.weeks) {
        expect(w).toHaveProperty('weekNumber');
        expect(w).toHaveProperty('weekStartDate');
        expect(w).toHaveProperty('openingBalance');
        expect(w).toHaveProperty('inflows');
        expect(w).toHaveProperty('outflows');
        expect(w).toHaveProperty('netCashFlow');
        expect(w).toHaveProperty('closingBalance');
        expect(w).toHaveProperty('isAlert');
        expect(w).toHaveProperty('source');
      }
    });

    it('closing balance of week N equals opening balance of week N+1', async () => {
      accountRepo.findByBusiness.mockResolvedValue(makeAccounts(1000000));
      JournalEntry.aggregate.mockResolvedValue([]);
      const result = await service.buildForecast(BIZ_ID);
      for (let i = 0; i < 12; i++) {
        expect(result.weeks[i].closingBalance).toBeCloseTo(result.weeks[i + 1].openingBalance, 0);
      }
    });

    it('week 1 opening balance equals current cash balance', async () => {
      accountRepo.findByBusiness.mockResolvedValue(makeAccounts(750000));
      JournalEntry.aggregate.mockResolvedValue([]);
      const result = await service.buildForecast(BIZ_ID);
      expect(result.currentCashBalance).toBeCloseTo(750000, 0);
      expect(result.weeks[0].openingBalance).toBeCloseTo(750000, 0);
    });

    it('isAlert is true when closingBalance < floorAmount', async () => {
      accountRepo.findByBusiness.mockResolvedValue(makeAccounts(100000));
      JournalEntry.aggregate.mockResolvedValue([]);
      const result = await service.buildForecast(BIZ_ID, { floorAmount: 200000 });
      // With no inflows, closing balances won't go up so week 1 closing should trigger alert
      const alertWeeks = result.weeks.filter(w => w.isAlert);
      expect(alertWeeks.length).toBeGreaterThan(0);
    });

    it('isAlert is false when closingBalance >= floorAmount', async () => {
      accountRepo.findByBusiness.mockResolvedValue(makeAccounts(5000000));
      JournalEntry.aggregate.mockResolvedValue([]);
      const result = await service.buildForecast(BIZ_ID, { floorAmount: 0 });
      const alertWeeks = result.weeks.filter(w => w.isAlert);
      expect(alertWeeks.length).toBe(0);
    });

    it('computes weeksUntilFloor correctly', async () => {
      accountRepo.findByBusiness.mockResolvedValue(makeAccounts(100000));
      JournalEntry.aggregate.mockResolvedValue([]);
      const result = await service.buildForecast(BIZ_ID, { floorAmount: 200000 });
      // First week closing is 100000 which is below 200000 floor → weeksUntilFloor = 1
      expect(result.weeksUntilFloor).toBe(1);
    });

    it('weeksUntilFloor is null when never below floor', async () => {
      accountRepo.findByBusiness.mockResolvedValue(makeAccounts(9999999));
      JournalEntry.aggregate.mockResolvedValue([]);
      const result = await service.buildForecast(BIZ_ID, { floorAmount: 0 });
      expect(result.weeksUntilFloor).toBeNull();
    });

    it('does not throw when account repo returns empty', async () => {
      accountRepo.findByBusiness.mockResolvedValue([]);
      JournalEntry.aggregate.mockResolvedValue([]);
      await expect(service.buildForecast(BIZ_ID)).resolves.toBeDefined();
    });

    it('does not throw when JournalEntry aggregate throws', async () => {
      accountRepo.findByBusiness.mockResolvedValue(makeAccounts());
      JournalEntry.aggregate.mockRejectedValue(new Error('DB failure'));
      await expect(service.buildForecast(BIZ_ID)).resolves.toBeDefined();
    });

    it('returns currentCashBalance in result', async () => {
      accountRepo.findByBusiness.mockResolvedValue(makeAccounts(300000));
      JournalEntry.aggregate.mockResolvedValue([]);
      const result = await service.buildForecast(BIZ_ID);
      expect(result.currentCashBalance).toBeCloseTo(300000, 0);
    });

    it('returns lowestPoint with weekNumber and balance', async () => {
      accountRepo.findByBusiness.mockResolvedValue(makeAccounts(200000));
      JournalEntry.aggregate.mockResolvedValue([]);
      const result = await service.buildForecast(BIZ_ID);
      expect(result.lowestPoint).toHaveProperty('weekNumber');
      expect(result.lowestPoint).toHaveProperty('balance');
    });

    it('returns generatedAt as Date', async () => {
      accountRepo.findByBusiness.mockResolvedValue(makeAccounts());
      JournalEntry.aggregate.mockResolvedValue([]);
      const result = await service.buildForecast(BIZ_ID);
      expect(result.generatedAt).toBeInstanceOf(Date);
    });

    it('weekNumber sequence is 1 to 13', async () => {
      accountRepo.findByBusiness.mockResolvedValue(makeAccounts());
      JournalEntry.aggregate.mockResolvedValue([]);
      const result = await service.buildForecast(BIZ_ID);
      result.weeks.forEach((w, i) => {
        expect(w.weekNumber).toBe(i + 1);
      });
    });
  });

  describe('getLiquidityAlerts', () => {
    it('returns only alert weeks', async () => {
      accountRepo.findByBusiness.mockResolvedValue(makeAccounts(50000));
      JournalEntry.aggregate.mockResolvedValue([]);
      const alerts = await service.getLiquidityAlerts(BIZ_ID, 100000);
      for (const w of alerts) {
        expect(w.isAlert).toBe(true);
      }
    });

    it('returns empty array when no alerts', async () => {
      accountRepo.findByBusiness.mockResolvedValue(makeAccounts(99999999));
      JournalEntry.aggregate.mockResolvedValue([]);
      const alerts = await service.getLiquidityAlerts(BIZ_ID, 0);
      expect(alerts).toEqual([]);
    });
  });
});

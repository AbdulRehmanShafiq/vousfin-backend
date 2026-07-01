'use strict';
jest.mock('../../../services/thirteenWeekCashFlow.service', () => ({ getLiquidityAlerts: jest.fn() }));
jest.mock('../../../services/report.service', () => ({ getAgingReport: jest.fn() }));
jest.mock('../../../services/businessHealth.service', () => ({ getHealthScore: jest.fn() }));
jest.mock('../../../services/stpScorecard.service', () => ({ getScorecard: jest.fn() }));
jest.mock('../../../services/aiDecision.service', () => ({ record: jest.fn().mockResolvedValue({ _id: 'dec9' }) }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const cashFlow = require('../../../services/thirteenWeekCashFlow.service');
const reportService = require('../../../services/report.service');
const businessHealth = require('../../../services/businessHealth.service');
const stpScorecard = require('../../../services/stpScorecard.service');
const aiDecisionService = require('../../../services/aiDecision.service');
const svc = require('../../../services/advisor.service');
const BIZ = '507f1f77bcf86cd799439099';

function healthyMocks() {
  cashFlow.getLiquidityAlerts.mockResolvedValue([]);
  reportService.getAgingReport.mockResolvedValue({ buckets: {
    days_61_90: { total: 0, items: [] }, days_over_90: { total: 0, items: [] },
  } });
  businessHealth.getHealthScore.mockResolvedValue({ insufficient: false, overall: 85 });
  stpScorecard.getScorecard.mockResolvedValue({ stpScore: 0.9 });
}

beforeEach(() => { jest.clearAllMocks(); healthyMocks(); });

describe('advisor.service.getRecommendations', () => {
  it('produces ranked recommendations from real signals', async () => {
    cashFlow.getLiquidityAlerts.mockResolvedValue([
      { weekStartDate: new Date('2026-07-06'), closingBalance: -45000, isAlert: true },
    ]);
    reportService.getAgingReport.mockResolvedValue({ buckets: {
      days_61_90: { total: 100000, items: [{}, {}] }, days_over_90: { total: 50000, items: [{}] },
    } });
    const r = await svc.getRecommendations(BIZ);
    expect(r.recommendations[0].id).toBe('cash_low_week');
    const chase = r.recommendations.find(x => x.id === 'chase_overdue_receivables');
    expect(chase.why).toContain('150,000');   // 100k + 50k over 60 days
    expect(chase.why).toContain('3');         // 2 + 1 invoices
  });

  it('records each advisory run in the AI Decision Ledger (kind recommend)', async () => {
    cashFlow.getLiquidityAlerts.mockResolvedValue([{ weekStartDate: new Date(), closingBalance: -1 }]);
    await svc.getRecommendations(BIZ);
    expect(aiDecisionService.record).toHaveBeenCalledWith(BIZ, 'recommend', expect.objectContaining({
      inputsSummary: expect.any(String),
    }));
  });

  it('returns an empty feed (and skips the ledger) when everything is healthy', async () => {
    const r = await svc.getRecommendations(BIZ);
    expect(r.recommendations).toEqual([]);
    expect(aiDecisionService.record).not.toHaveBeenCalled();
  });

  it('is fault-isolated — one failing engine drops only its signal', async () => {
    cashFlow.getLiquidityAlerts.mockRejectedValue(new Error('forecast down'));
    reportService.getAgingReport.mockResolvedValue({ buckets: {
      days_61_90: { total: 80000, items: [{}] }, days_over_90: { total: 0, items: [] },
    } });
    const r = await svc.getRecommendations(BIZ);
    expect(r.recommendations.map(x => x.id)).toEqual(['chase_overdue_receivables']);
  });

  it('ignores an insufficient health score instead of flagging it', async () => {
    businessHealth.getHealthScore.mockResolvedValue({ insufficient: true });
    const r = await svc.getRecommendations(BIZ);
    expect(r.recommendations.find(x => x.id === 'weak_health')).toBeUndefined();
  });
});

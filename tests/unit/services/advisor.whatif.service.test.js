'use strict';
jest.mock('../../../services/thirteenWeekCashFlow.service', () => ({ getLiquidityAlerts: jest.fn() }));
jest.mock('../../../services/report.service', () => ({ getAgingReport: jest.fn() }));
jest.mock('../../../services/businessHealth.service', () => ({ getHealthScore: jest.fn() }));
jest.mock('../../../services/stpScorecard.service', () => ({ getScorecard: jest.fn() }));
jest.mock('../../../services/aiDecision.service', () => ({ record: jest.fn().mockResolvedValue({ _id: 'd' }) }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const businessHealth = require('../../../services/businessHealth.service');
const aiDecisionService = require('../../../services/aiDecision.service');
const svc = require('../../../services/advisor.service');
const BIZ = '507f1f77bcf86cd799439099';

beforeEach(() => {
  jest.clearAllMocks();
  businessHealth.getHealthScore.mockResolvedValue({ insufficient: false, overall: 70, metrics: { cashBalance: 1200000, monthlyBurn: 200000 } });
});

describe('advisor.service.answerWhatIf', () => {
  it('answers a hiring question with a grounded runway projection', async () => {
    const r = await svc.answerWhatIf(BIZ, 'Can I afford to hire 2 people at Rs 60,000 each?');
    expect(r.understood).toBe(true);
    expect(r.projection.runwayBefore).toBe(6);
    expect(r.projection.runwayAfter).toBe(3.8); // 1.2M / (200k+120k) = 3.75 → 3.8
    expect(r.answer).toMatch(/runway/i);
    expect(aiDecisionService.record).toHaveBeenCalledWith(BIZ, 'recommend', expect.objectContaining({ inputsSummary: expect.stringContaining('hire') }));
  });

  it('asks for more detail when it cannot ground the question', async () => {
    const r = await svc.answerWhatIf(BIZ, 'should I rebrand?');
    expect(r.understood).toBe(false);
    expect(r.answer).toMatch(/hiring|spending|can.?t/i);
  });

  it('asks for the salary when a hire has no amount', async () => {
    const r = await svc.answerWhatIf(BIZ, 'can I afford to hire 3 people');
    expect(r.understood).toBe(false);
    expect(r.answer).toMatch(/monthly pay|salary/i);
  });
});

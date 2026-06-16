'use strict';

jest.mock('../../../services/autonomyPolicy.service', () => ({ getPolicy: jest.fn() }));
jest.mock('../../../services/feedback.service', () => ({ getStats: jest.fn() }));

const policy = require('../../../services/autonomyPolicy.service');
const feedback = require('../../../services/feedback.service');
const report = require('../../../services/autonomyReport.service');

const BIZ = 'biz1';

function mockPolicy(levels = {}) {
  const caps = {};
  for (const c of ['bookkeeping', 'reconciliation', 'collections', 'payments', 'tax', 'close', 'advisory']) {
    caps[c] = { level: levels[c] || 'suggest', confidenceThreshold: 0.85, maxAutoAmount: null };
  }
  policy.getPolicy.mockResolvedValue({ businessId: BIZ, capabilities: caps });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPolicy();
  feedback.getStats.mockResolvedValue({});
});

describe('autonomyReport.getReport', () => {
  it('lists every capability with its level, stats and (no) recommendation by default', async () => {
    const r = await report.getReport(BIZ);
    expect(r.capabilities).toHaveLength(7);
    const tax = r.capabilities.find(c => c.capability === 'tax');
    expect(tax.level).toBe('suggest');
    expect(tax.total).toBe(0);
    expect(tax.recommendation).toBeNull();
    expect(r.summary.totalDecisions).toBe(0);
  });

  it('recommends dialing UP a "suggest" capability that is highly accurate over enough decisions', async () => {
    feedback.getStats.mockResolvedValue({ tax: { total: 20, approved: 20, rejected: 0, edited: 0, accuracy: 1 } });
    const r = await report.getReport(BIZ);
    const tax = r.capabilities.find(c => c.capability === 'tax');
    expect(tax.recommendation.to).toBe('copilot');
    expect(tax.recommendation.reason).toMatch(/decisions/i);
  });

  it('does not recommend a change without enough decisions', async () => {
    feedback.getStats.mockResolvedValue({ tax: { total: 3, approved: 3, rejected: 0, edited: 0, accuracy: 1 } });
    const r = await report.getReport(BIZ);
    expect(r.capabilities.find(c => c.capability === 'tax').recommendation).toBeNull();
  });

  it('recommends dialing DOWN a copilot capability with poor accuracy', async () => {
    mockPolicy({ payments: 'copilot' });
    feedback.getStats.mockResolvedValue({ payments: { total: 15, approved: 9, rejected: 6, edited: 0, accuracy: 0.6 } });
    const r = await report.getReport(BIZ);
    const pay = r.capabilities.find(c => c.capability === 'payments');
    expect(pay.recommendation.to).toBe('suggest');
  });

  it('summarises overall decisions, accuracy and posture', async () => {
    mockPolicy({ tax: 'autopilot', payments: 'copilot' });
    feedback.getStats.mockResolvedValue({
      tax:      { total: 10, approved: 10, rejected: 0, edited: 0, accuracy: 1 },
      payments: { total: 10, approved: 8,  rejected: 2, edited: 0, accuracy: 0.8 },
    });
    const r = await report.getReport(BIZ);
    expect(r.summary.totalDecisions).toBe(20);
    expect(r.summary.accuracy).toBeCloseTo(0.9);
    expect(r.summary.capabilitiesBeyondSuggest).toBe(2);
  });
});

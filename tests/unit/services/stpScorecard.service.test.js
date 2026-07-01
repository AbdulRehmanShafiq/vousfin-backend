'use strict';
jest.mock('../../../models/JournalEntry.model', () => ({ countDocuments: jest.fn() }));
jest.mock('../../../models/Bill.model', () => ({ countDocuments: jest.fn() }));
jest.mock('../../../models/BankStatement.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../../repositories/aiDecision.repository', () => ({ outcomeBreakdown: jest.fn() }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const JournalEntry = require('../../../models/JournalEntry.model');
const Bill = require('../../../models/Bill.model');
const BankStatement = require('../../../models/BankStatement.model');
const aiDecisionRepo = require('../../../repositories/aiDecision.repository');
const svc = require('../../../services/stpScorecard.service');
const BIZ = '507f1f77bcf86cd799439099';

beforeEach(() => jest.clearAllMocks());

describe('stpScorecard.service.getScorecard', () => {
  it('gathers counts per capability and computes the scorecard', async () => {
    // posting: total user-originated 100, auto-posted 30
    JournalEntry.countDocuments
      .mockResolvedValueOnce(100)  // total user-originated
      .mockResolvedValueOnce(30);  // ai_auto_posted
    // matching: 20 bills match-ran, 15 clean-matched
    Bill.countDocuments
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(15);
    // reconciliation: 50 lines resolved, 40 auto-matched
    BankStatement.aggregate.mockResolvedValue([{ total: 50, automated: 40 }]);
    // categorization: 40 resolved, 36 accepted
    aiDecisionRepo.outcomeBreakdown.mockResolvedValue({ pending: 5, accepted: 36, corrected: 4, reversed: 0 });

    const s = await svc.getScorecard(BIZ, { days: 90 });
    expect(s.posting.rate).toBe(0.3);
    expect(s.matching.rate).toBe(0.75);
    expect(s.reconciliation.rate).toBe(0.8);
    expect(s.categorization.rate).toBe(0.9);
    expect(s.stpScore).toBe(0.6875);
    expect(s.windowDays).toBe(90);

    // tenancy: every query is businessId-scoped
    for (const call of JournalEntry.countDocuments.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({ businessId: BIZ }));
    }
    for (const call of Bill.countDocuments.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({ businessId: BIZ }));
    }
  });

  it('is fault-isolated — one failing source zeroes only that capability', async () => {
    JournalEntry.countDocuments.mockRejectedValue(new Error('db down'));
    Bill.countDocuments.mockResolvedValueOnce(10).mockResolvedValueOnce(5);
    BankStatement.aggregate.mockResolvedValue([]);
    aiDecisionRepo.outcomeBreakdown.mockResolvedValue({ pending: 0, accepted: 0, corrected: 0, reversed: 0 });

    const s = await svc.getScorecard(BIZ);
    expect(s.posting.rate).toBeNull();      // failed source → no signal, not a crash
    expect(s.matching.rate).toBe(0.5);      // healthy sources still report
  });
});

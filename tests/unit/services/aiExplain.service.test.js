'use strict';
jest.mock('../../../services/aiDecision.service', () => ({ getById: jest.fn() }));
const aiDecisionService = require('../../../services/aiDecision.service');
const svc = require('../../../services/aiExplain.service');
const BIZ = '507f1f77bcf86cd799439099';

beforeEach(() => jest.clearAllMocks());

describe('aiExplain.service.explainById', () => {
  it('returns the decision plus a grounded explanation', async () => {
    aiDecisionService.getById.mockResolvedValue({
      _id: 'd1', kind: 'parse', inputsSummary: 'Paid rent',
      decision: { transactionType: 'Expense', debitAccount: 'Rent', creditAccount: 'Cash', amount: 5000 },
      confidence: 0.97, outcome: 'accepted',
    });
    const r = await svc.explainById('d1', BIZ);
    expect(aiDecisionService.getById).toHaveBeenCalledWith('d1', BIZ);
    expect(r.decision._id).toBe('d1');
    expect(r.explanation.text).toContain('Rent');
    expect(r.explanation.faithful).toBe(true);
  });

  it('returns null when the decision is not found (tenant miss)', async () => {
    aiDecisionService.getById.mockResolvedValue(null);
    expect(await svc.explainById('missing', BIZ)).toBeNull();
  });
});

'use strict';
jest.mock('../../../models/AIDecision.model', () => {
  const m = function () {};
  m.find = jest.fn(); m.findOne = jest.fn(); m.findOneAndUpdate = jest.fn(); m.countDocuments = jest.fn();
  return m;
});
const AIDecision = require('../../../models/AIDecision.model');
const repo = require('../../../repositories/aiDecision.repository');
const BIZ = '507f1f77bcf86cd799439099';

beforeEach(() => jest.clearAllMocks());

describe('aiDecision.repository', () => {
  it('findByBusiness filters by businessId and paginates', async () => {
    const sort = jest.fn(() => ({ skip: () => ({ limit: () => ({ lean: () => Promise.resolve([{ _id: 'd1' }]) }) }) }));
    AIDecision.find.mockReturnValue({ sort });
    AIDecision.countDocuments.mockResolvedValue(1);
    const r = await repo.findByBusiness(BIZ, { kind: 'parse', page: 1, limit: 25 });
    expect(AIDecision.find).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ, kind: 'parse' }));
    expect(r.total).toBe(1);
    expect(r.data).toHaveLength(1);
  });

  it('setOutcome guards the one-time transition and writes resolvedAt', async () => {
    AIDecision.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'd1', outcome: 'pending' }) });
    AIDecision.findOneAndUpdate.mockResolvedValue({ _id: 'd1', outcome: 'accepted' });
    const r = await repo.setOutcome('d1', BIZ, 'accepted');
    expect(AIDecision.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'd1', businessId: BIZ },
      expect.objectContaining({ outcome: 'accepted', resolvedAt: expect.any(Date) }),
      { new: true },
    );
    expect(r.outcome).toBe('accepted');
  });

  it('setOutcome refuses to change an already-set outcome', async () => {
    AIDecision.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'd1', outcome: 'accepted' }) });
    await expect(repo.setOutcome('d1', BIZ, 'corrected')).rejects.toThrow(/already set/i);
    expect(AIDecision.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('setOutcome returns null when the decision is not found', async () => {
    AIDecision.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    const r = await repo.setOutcome('missing', BIZ, 'accepted');
    expect(r).toBeNull();
  });
});

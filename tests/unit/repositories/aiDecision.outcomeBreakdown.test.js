'use strict';
jest.mock('../../../models/AIDecision.model', () => {
  const m = function () {};
  m.aggregate = jest.fn();
  return m;
});
const AIDecision = require('../../../models/AIDecision.model');
const repo = require('../../../repositories/aiDecision.repository');
const BIZ = '507f1f77bcf86cd799439099';

beforeEach(() => jest.clearAllMocks());

describe('aiDecision.repository.outcomeBreakdown', () => {
  it('groups counts by outcome and fills missing buckets with zero', async () => {
    AIDecision.aggregate.mockResolvedValue([
      { _id: 'accepted', count: 70 },
      { _id: 'reversed', count: 10 },
    ]);
    const r = await repo.outcomeBreakdown(BIZ, 'parse');
    expect(r).toEqual({ pending: 0, accepted: 70, corrected: 0, reversed: 10 });
    // first pipeline stage must scope by tenant (and kind when given)
    const pipeline = AIDecision.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match).toEqual(expect.objectContaining({ businessId: BIZ, kind: 'parse' }));
  });

  it('omits the kind filter when no kind is given', async () => {
    AIDecision.aggregate.mockResolvedValue([]);
    await repo.outcomeBreakdown(BIZ);
    const pipeline = AIDecision.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match).toEqual({ businessId: BIZ });
  });
});

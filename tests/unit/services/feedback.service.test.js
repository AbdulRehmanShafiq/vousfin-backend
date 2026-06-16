'use strict';

const mockModel = { create: jest.fn(), aggregate: jest.fn() };
jest.mock('mongoose', () => ({ model: () => mockModel, Types: { ObjectId: function (v) { this.v = v; } } }));

const feedback = require('../../../services/feedback.service');

const BIZ = 'biz1';

beforeEach(() => {
  jest.clearAllMocks();
  mockModel.create.mockResolvedValue({ _id: 'f1' });
  mockModel.aggregate.mockResolvedValue([]);
});

describe('feedback.record', () => {
  it('persists a verdict event', async () => {
    await feedback.record({ businessId: BIZ, capability: 'tax', actionType: 'file_return', verdict: 'approved', confidence: 0.9 });
    expect(mockModel.create).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ, capability: 'tax', verdict: 'approved' }));
  });
  it('never throws (best-effort) on a write error', async () => {
    mockModel.create.mockRejectedValue(new Error('db down'));
    await expect(feedback.record({ businessId: BIZ, capability: 'tax', verdict: 'approved' })).resolves.toBeNull();
  });
});

describe('feedback.getStats', () => {
  it('shapes per-capability accuracy from the aggregation', async () => {
    mockModel.aggregate.mockResolvedValue([
      { _id: 'tax', total: 10, approved: 9, rejected: 1, edited: 0 },
      { _id: 'payments', total: 4, approved: 2, rejected: 1, edited: 1 },
    ]);
    const stats = await feedback.getStats(BIZ);
    expect(stats.tax).toMatchObject({ total: 10, approved: 9 });
    expect(stats.tax.accuracy).toBeCloseTo(0.9);          // approved / total
    expect(stats.payments.accuracy).toBeCloseTo(0.5);
  });
  it('returns an empty object when there is no feedback yet', async () => {
    const stats = await feedback.getStats(BIZ);
    expect(stats).toEqual({});
  });
});

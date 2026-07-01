'use strict';
jest.mock('../../../repositories/aiDecision.repository', () => ({
  create: jest.fn(), setOutcome: jest.fn(), findByBusiness: jest.fn(), findByIdForBusiness: jest.fn(),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const repo = require('../../../repositories/aiDecision.repository');
const service = require('../../../services/aiDecision.service');
const BIZ = '507f1f77bcf86cd799439099';

beforeEach(() => jest.clearAllMocks());

describe('aiDecision.service', () => {
  it('record persists a built record and returns it', async () => {
    repo.create.mockResolvedValue({ _id: 'd1' });
    const doc = await service.record(BIZ, 'parse', { inputsSummary: 'Paid rent', confidence: 0.9 });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ, kind: 'parse', outcome: 'pending' }));
    expect(doc._id).toBe('d1');
  });

  it('record NEVER throws — a repo failure returns null and logs', async () => {
    repo.create.mockRejectedValue(new Error('db down'));
    const doc = await service.record(BIZ, 'parse', { inputsSummary: 'Paid rent' });
    expect(doc).toBeNull();
  });

  it('record NEVER throws — an invalid payload returns null (does not surface to caller)', async () => {
    const doc = await service.record(BIZ, 'parse', { inputsSummary: '' }); // helper would throw
    expect(doc).toBeNull();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('recordOutcome delegates and never throws on failure', async () => {
    repo.setOutcome.mockRejectedValue(new Error('boom'));
    await expect(service.recordOutcome('d1', BIZ, 'accepted')).resolves.toBeUndefined();
  });

  it('recordOutcome is a no-op when decisionId is falsy', async () => {
    await service.recordOutcome(null, BIZ, 'accepted');
    expect(repo.setOutcome).not.toHaveBeenCalled();
  });
});

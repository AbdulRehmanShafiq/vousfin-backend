'use strict';
jest.mock('../../../repositories/aiDecision.repository', () => ({ outcomeBreakdown: jest.fn() }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const repo = require('../../../repositories/aiDecision.repository');
const svc = require('../../../services/aiCalibration.service');
const BIZ = '507f1f77bcf86cd799439099';

beforeEach(() => jest.clearAllMocks());

describe('computeAcceptanceStats', () => {
  it('turns the repo outcome breakdown into rates', async () => {
    repo.outcomeBreakdown.mockResolvedValue({ pending: 10, accepted: 70, corrected: 20, reversed: 10 });
    const s = await svc.computeAcceptanceStats(BIZ, { kind: 'parse' });
    expect(repo.outcomeBreakdown).toHaveBeenCalledWith(BIZ, 'parse');
    expect(s.acceptanceRate).toBe(0.7);
    expect(s.reversalRate).toBe(0.1);
    expect(s.resolved).toBe(100);
  });

  it('never throws — a repo failure yields all-zero stats', async () => {
    repo.outcomeBreakdown.mockRejectedValue(new Error('db down'));
    const s = await svc.computeAcceptanceStats(BIZ);
    expect(s.resolved).toBe(0);
    expect(s.acceptanceRate).toBe(0);
  });
});

describe('getEffectiveAutoPostThreshold', () => {
  it('returns base when signal is thin', async () => {
    repo.outcomeBreakdown.mockResolvedValue({ pending: 0, accepted: 3, corrected: 0, reversed: 0 });
    expect(await svc.getEffectiveAutoPostThreshold(BIZ, 0.98)).toBe(0.98);
  });

  it('tightens above base when the tenant has been reversing auto-posts', async () => {
    repo.outcomeBreakdown.mockResolvedValue({ pending: 0, accepted: 80, corrected: 10, reversed: 10 });
    const t = await svc.getEffectiveAutoPostThreshold(BIZ, 0.98);
    expect(t).toBeGreaterThan(0.98);
  });

  it('never throws — falls back to base on error', async () => {
    repo.outcomeBreakdown.mockRejectedValue(new Error('boom'));
    expect(await svc.getEffectiveAutoPostThreshold(BIZ, 0.98)).toBe(0.98);
  });
});

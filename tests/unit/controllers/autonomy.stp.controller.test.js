'use strict';
// Focused test for the Phase 3 endpoints on the autonomy controller:
// GET /autonomy/stp-scorecard and GET /autonomy/close/readiness.
jest.mock('../../../services/stpScorecard.service', () => ({ getScorecard: jest.fn() }));
jest.mock('../../../services/closeReadiness.service', () => ({ getReadiness: jest.fn() }));
jest.mock('../../../services/brainContext.service', () => ({ getContext: jest.fn() }));

const stpScorecard = require('../../../services/stpScorecard.service');
const closeReadiness = require('../../../services/closeReadiness.service');
const brainContext = require('../../../services/brainContext.service');
const ctrl = require('../../../controllers/autonomy.controller');

const mockRes = () => { const r = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r; };
const req = (over = {}) => ({ user: { id: 'u1', businessId: 'biz1' }, query: {}, params: {}, body: {}, ...over });
const next = jest.fn();
beforeEach(() => jest.clearAllMocks());

describe('autonomy controller — STP scorecard', () => {
  test('returns the tenant scorecard honouring ?days=', async () => {
    stpScorecard.getScorecard.mockResolvedValue({ stpScore: 0.7, windowDays: 30 });
    const res = mockRes();
    await ctrl.getStpScorecard(req({ query: { days: '30' } }), res, next);
    expect(stpScorecard.getScorecard).toHaveBeenCalledWith('biz1', { days: 30 });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  test('clamps a nonsense days value to the default', async () => {
    stpScorecard.getScorecard.mockResolvedValue({ stpScore: null });
    await ctrl.getStpScorecard(req({ query: { days: 'banana' } }), mockRes(), next);
    expect(stpScorecard.getScorecard).toHaveBeenCalledWith('biz1', { days: 90 });
  });
});

describe('autonomy controller — close readiness', () => {
  test('returns the readiness checklist', async () => {
    closeReadiness.getReadiness.mockResolvedValue({ closeable: true, score: 80, ready: false });
    const res = mockRes();
    await ctrl.getCloseReadiness(req(), res, next);
    expect(closeReadiness.getReadiness).toHaveBeenCalledWith('biz1');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  test('delegates errors to next()', async () => {
    closeReadiness.getReadiness.mockRejectedValue(new Error('boom'));
    await ctrl.getCloseReadiness(req(), mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('autonomy controller — brain context (Phase 6)', () => {
  test('returns the unified tenant context', async () => {
    brainContext.getContext.mockResolvedValue({ learning: { totalLearnedFacts: 12 }, asOf: 'now' });
    const res = mockRes();
    await ctrl.getBrainContext(req(), res, next);
    expect(brainContext.getContext).toHaveBeenCalledWith('biz1');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

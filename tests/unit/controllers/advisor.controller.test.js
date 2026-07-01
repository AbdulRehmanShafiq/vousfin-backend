'use strict';
jest.mock('../../../services/advisor.service', () => ({ getRecommendations: jest.fn() }));
const advisorService = require('../../../services/advisor.service');
const ctrl = require('../../../controllers/advisor.controller');

const mockRes = () => { const r = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r; };
const req = (over = {}) => ({ user: { id: 'u1', businessId: 'biz1' }, query: {}, params: {}, ...over });
const next = jest.fn();
beforeEach(() => jest.clearAllMocks());

describe('advisor.controller.getRecommendations', () => {
  test('returns the tenant advisory feed', async () => {
    advisorService.getRecommendations.mockResolvedValue({ recommendations: [{ id: 'cash_low_week' }] });
    const res = mockRes();
    await ctrl.getRecommendations(req(), res, next);
    expect(advisorService.getRecommendations).toHaveBeenCalledWith('biz1');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('delegates errors to next()', async () => {
    advisorService.getRecommendations.mockRejectedValue(new Error('boom'));
    await ctrl.getRecommendations(req(), mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

// tests/unit/controllers/cost.controller.test.js
'use strict';
jest.mock('../../../services/jobCosting.service');
jest.mock('../../../services/profitability.service');
jest.mock('../../../services/breakEven.service');
const jobCosting = require('../../../services/jobCosting.service');
const breakEven = require('../../../services/breakEven.service');
const ctrl = require('../../../controllers/cost.controller');
const mkRes = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };
const req = (over = {}) => ({ user: { businessId: 'biz1', id: 'u1', role: 'owner' }, params: {}, query: {}, body: {}, ...over });
describe('cost.controller', () => {
  beforeEach(() => jest.clearAllMocks());
  test('createJob → 201', async () => {
    jobCosting.createJob.mockResolvedValue({ _id: 'j1' });
    const res = mkRes();
    await ctrl.createJob(req({ body: { code: 'J1' } }), res, jest.fn());
    expect(jobCosting.createJob).toHaveBeenCalledWith('biz1', { code: 'J1' }, expect.objectContaining({ id: 'u1' }));
    expect(res.status).toHaveBeenCalledWith(201);
  });
  test('breakEven delegates body to service', async () => {
    breakEven.breakEvenPoint.mockReturnValue({ feasible: true });
    const res = mkRes();
    await ctrl.breakEven(req({ body: { fixedCosts: 1, pricePerUnit: 2, variableCostPerUnit: 1 } }), res, jest.fn());
    expect(breakEven.breakEvenPoint).toHaveBeenCalledWith(expect.objectContaining({ fixedCosts: 1 }));
  });
});

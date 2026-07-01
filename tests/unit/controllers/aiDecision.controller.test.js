'use strict';
jest.mock('../../../services/aiDecision.service', () => ({ list: jest.fn(), getById: jest.fn() }));
const service = require('../../../services/aiDecision.service');
const ctrl = require('../../../controllers/aiDecision.controller');
const { ApiError } = require('../../../utils/ApiError');

const mockRes = () => { const r = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r; };
const req = (over = {}) => ({ user: { id: 'u1', businessId: 'biz1' }, query: {}, params: {}, ...over });
const next = jest.fn();
beforeEach(() => jest.clearAllMocks());

describe('aiDecision.controller', () => {
  test('list returns paginated decisions for the tenant', async () => {
    service.list.mockResolvedValue({ data: [{ _id: 'd1' }], total: 1, page: 1, limit: 25 });
    const res = mockRes();
    await ctrl.list(req({ query: { kind: 'parse' } }), res, next);
    expect(service.list).toHaveBeenCalledWith('biz1', expect.objectContaining({ kind: 'parse' }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('getById 404s when not found', async () => {
    service.getById.mockResolvedValue(null);
    await ctrl.getById(req({ params: { id: 'missing' } }), mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });

  test('getById returns the decision when found', async () => {
    service.getById.mockResolvedValue({ _id: 'd1', kind: 'parse' });
    const res = mockRes();
    await ctrl.getById(req({ params: { id: 'd1' } }), res, next);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

// tests/unit/controllers/budget.controller.test.js
'use strict';
jest.mock('../../../services/budget.service');
jest.mock('../../../services/variance.service');
const budget = require('../../../services/budget.service');
const ctrl = require('../../../controllers/budget.controller');

const mkRes = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };
const req = (over = {}) => ({ user: { businessId: 'biz1', id: 'u1', role: 'owner' }, params: {}, query: {}, body: {}, ...over });

describe('budget.controller', () => {
  beforeEach(() => jest.clearAllMocks());
  test('create delegates to createDraft and returns 201', async () => {
    budget.createDraft.mockResolvedValue({ _id: 'b1' });
    const res = mkRes();
    await ctrl.create(req({ body: { name: 'X' } }), res, jest.fn());
    expect(budget.createDraft).toHaveBeenCalledWith('biz1', { name: 'X' }, expect.objectContaining({ id: 'u1' }));
    expect(res.status).toHaveBeenCalledWith(201);
  });
  test('list passes query filters', async () => {
    budget.list.mockResolvedValue([]);
    const res = mkRes();
    await ctrl.list(req({ query: { scenario: 'base' } }), res, jest.fn());
    expect(budget.list).toHaveBeenCalledWith('biz1', expect.objectContaining({ scenario: 'base' }));
  });
});

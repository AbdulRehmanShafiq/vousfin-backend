'use strict';

const ctrl = require('../../../controllers/reportTemplate.controller');
const repo = require('../../../repositories/reportTemplate.repository');
jest.mock('../../../repositories/reportTemplate.repository');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

describe('reportTemplate.controller.list', () => {
  test('returns owned templates', async () => {
    repo.findOwned.mockResolvedValue([{ _id: 't1', name: 'P&L' }]);
    const req = { user: { businessId: 'biz1' } };
    const res = mockRes();
    await ctrl.list(req, res, (e) => { throw e; });
    expect(repo.findOwned).toHaveBeenCalledWith('biz1');
    expect(res.json).toHaveBeenCalled();
  });
});

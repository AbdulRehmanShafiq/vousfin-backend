// tests/unit/repositories/job.repository.test.js
'use strict';
jest.mock('../../../models/Job.model', () => {
  const m = function () {}; m.find = jest.fn(); m.findOne = jest.fn(); return m;
});
const Job = require('../../../models/Job.model');
const repo = require('../../../repositories/job.repository');
describe('job.repository', () => {
  beforeEach(() => jest.clearAllMocks());
  test('findByCode queries businessId+code', async () => {
    Job.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'j1' }) });
    const r = await repo.findByCode('biz1', 'J1');
    expect(Job.findOne).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'biz1', code: 'J1' }));
    expect(r._id).toBe('j1');
  });
  test('findOwned applies status filter and sorts by createdAt desc', async () => {
    const sort = jest.fn(() => ({ lean: () => Promise.resolve([]) }));
    Job.find.mockReturnValue({ sort });
    await repo.findOwned('biz1', { status: 'open' });
    expect(Job.find).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'biz1', status: 'open' }));
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
  });
});

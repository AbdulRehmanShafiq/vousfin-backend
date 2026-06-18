// tests/unit/repositories/budget.repository.test.js
'use strict';
jest.mock('../../../models/Budget.model', () => {
  const m = function () {};
  m.find = jest.fn();
  m.findOne = jest.fn();
  return m;
});
const Budget = require('../../../models/Budget.model');
const repo = require('../../../repositories/budget.repository');

describe('budget.repository', () => {
  beforeEach(() => jest.clearAllMocks());

  test('findActive queries businessId+fy+scenario+status=active', async () => {
    Budget.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'b1' }) });
    const r = await repo.findActive('biz1', 'fy1', 'base');
    expect(Budget.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: 'biz1', fiscalYearId: 'fy1', scenario: 'base', status: 'active' }));
    expect(r._id).toBe('b1');
  });

  test('findVersions sorts by version desc', async () => {
    const sort = jest.fn(() => ({ lean: () => Promise.resolve([{ version: 2 }, { version: 1 }]) }));
    Budget.find.mockReturnValue({ sort });
    const r = await repo.findVersions('biz1', 'fy1', 'base');
    expect(sort).toHaveBeenCalledWith({ version: -1 });
    expect(r[0].version).toBe(2);
  });

  test('findOwned applies status/scenario filters', async () => {
    const sort = jest.fn(() => ({ lean: () => Promise.resolve([]) }));
    Budget.find.mockReturnValue({ sort });
    await repo.findOwned('biz1', { scenario: 'base', status: 'active' });
    expect(Budget.find).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: 'biz1', scenario: 'base', status: 'active' }));
  });
});

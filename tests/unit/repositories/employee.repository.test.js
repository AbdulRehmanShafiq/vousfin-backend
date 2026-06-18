'use strict';
jest.mock('../../../models/Employee.model', () => {
  const fn = jest.fn();
  return { find: fn, findOne: jest.fn(), findById: jest.fn(), countDocuments: jest.fn() };
});
const Employee = require('../../../models/Employee.model');
const repo = require('../../../repositories/employee.repository');

const BIZ = 'biz1';
const lean = (v) => ({ lean: () => Promise.resolve(v) });

beforeEach(() => jest.clearAllMocks());

describe('employee.repository', () => {
  it('findByCode looks up a business-scoped code', async () => {
    Employee.findOne.mockReturnValue(lean({ _id: 'e1', code: 'E001' }));
    const e = await repo.findByCode(BIZ, 'E001');
    expect(Employee.findOne).toHaveBeenCalledWith({ businessId: BIZ, code: 'E001' });
    expect(e).toMatchObject({ code: 'E001' });
  });

  it('findActive returns only active employees, sorted by code', async () => {
    const sort = jest.fn().mockReturnValue(lean([{ code: 'E001' }]));
    Employee.find.mockReturnValue({ sort });
    const list = await repo.findActive(BIZ);
    expect(Employee.find).toHaveBeenCalledWith({ businessId: BIZ, status: 'active' });
    expect(list).toHaveLength(1);
  });
});

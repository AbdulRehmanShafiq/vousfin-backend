'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../models/PayrollAccrual.model', () => ({
  findOneAndUpdate: jest.fn(),
  findOne:          jest.fn(),
}));

const Model = require('../../../models/PayrollAccrual.model');
const repo  = require('../../../repositories/payrollAccrual.repository');

beforeEach(() => jest.clearAllMocks());

describe('payrollAccrual.repository.upsertForMonth', () => {
  it('upserts on the (businessId, month) key with eobi/sessi/createdBy', async () => {
    Model.findOneAndUpdate.mockReturnValue({ lean: () => Promise.resolve({ _id: 'a1' }) });

    const out = await repo.upsertForMonth('biz1', '2026-06', { eobi: 5000, sessi: 3000, createdBy: 'u1' });

    const [filter, update, options] = Model.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ businessId: 'biz1', month: '2026-06' });
    expect(update.$set).toMatchObject({ businessId: 'biz1', month: '2026-06', eobi: 5000, sessi: 3000, createdBy: 'u1' });
    expect(options).toMatchObject({ upsert: true, new: true });
    expect(out).toEqual({ _id: 'a1' });
  });

  it('defaults eobi/sessi to 0 when omitted', async () => {
    Model.findOneAndUpdate.mockReturnValue({ lean: () => Promise.resolve({}) });
    await repo.upsertForMonth('biz1', '2026-06', {});
    expect(Model.findOneAndUpdate.mock.calls[0][1].$set).toMatchObject({ eobi: 0, sessi: 0 });
  });
});

describe('payrollAccrual.repository.latest', () => {
  it('returns the newest month first', async () => {
    const lean = jest.fn().mockResolvedValue({ month: '2026-06' });
    const sort = jest.fn(() => ({ lean }));
    Model.findOne.mockReturnValue({ sort });

    const out = await repo.latest('biz1');

    expect(Model.findOne).toHaveBeenCalledWith({ businessId: 'biz1' });
    expect(sort).toHaveBeenCalledWith({ month: -1 });
    expect(out).toEqual({ month: '2026-06' });
  });
});

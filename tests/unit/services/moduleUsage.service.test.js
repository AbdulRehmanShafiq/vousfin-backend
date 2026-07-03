'use strict';
jest.mock('../../../models/ModuleUsage.model', () => ({ findOneAndUpdate: jest.fn(), find: jest.fn() }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ModuleUsage = require('../../../models/ModuleUsage.model');
const svc = require('../../../services/moduleUsage.service');
const BIZ = 'biz1', USER = 'user1';

beforeEach(() => jest.clearAllMocks());

describe('moduleUsage.service.record', () => {
  it('upserts an incrementing usage row scoped to business+user+module', async () => {
    ModuleUsage.findOneAndUpdate.mockResolvedValue({ _id: 'u1' });
    await svc.record(BIZ, USER, { moduleKey: 'invoices', label: 'Invoices', path: '/sales/invoices' });
    expect(ModuleUsage.findOneAndUpdate).toHaveBeenCalledWith(
      { businessId: BIZ, userId: USER, moduleKey: 'invoices' },
      expect.objectContaining({ $inc: { count: 1 }, $set: expect.objectContaining({ label: 'Invoices', path: '/sales/invoices' }) }),
      expect.objectContaining({ upsert: true }),
    );
  });

  it('is a safe no-op when required fields are missing (never throws)', async () => {
    await svc.record(BIZ, USER, { label: 'x' }); // no moduleKey
    await svc.record(BIZ, null, { moduleKey: 'invoices', label: 'Invoices', path: '/x' });
    expect(ModuleUsage.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('never throws even if the DB write fails', async () => {
    ModuleUsage.findOneAndUpdate.mockRejectedValue(new Error('db down'));
    await expect(svc.record(BIZ, USER, { moduleKey: 'invoices', label: 'Invoices', path: '/x' })).resolves.toBeUndefined();
  });
});

describe('moduleUsage.service.getShortcuts', () => {
  it('returns ranked display shortcuts', async () => {
    ModuleUsage.find.mockReturnValue({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([
      { moduleKey: 'invoices', label: 'Invoices', path: '/sales/invoices', count: 10, lastUsedAt: new Date() },
      { moduleKey: 'bills', label: 'Bills', path: '/purchases/bills', count: 4, lastUsedAt: new Date() },
    ]) }) }) });
    const r = await svc.getShortcuts(BIZ, USER, { limit: 5 });
    expect(ModuleUsage.find).toHaveBeenCalledWith({ businessId: BIZ, userId: USER });
    expect(r[0]).toEqual({ moduleKey: 'invoices', label: 'Invoices', path: '/sales/invoices' });
  });

  it('returns [] on failure instead of throwing', async () => {
    ModuleUsage.find.mockImplementation(() => { throw new Error('boom'); });
    expect(await svc.getShortcuts(BIZ, USER)).toEqual([]);
  });
});

'use strict';
jest.mock('../../../models/ChartOfAccount.model', () => ({ create: jest.fn() }));
jest.mock('../../../services/audit.service', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ChartOfAccount = require('../../../models/ChartOfAccount.model');
const svc = require('../../../services/importAccountResolution.service');
const BIZ = '507f1f77bcf86cd799439099';

const COA = () => ([
  { _id: 'a1', accountCode: '1010', accountName: 'Cash at Bank',         accountType: 'Asset',  normalBalance: 'Debit' },
  { _id: 'a4', accountCode: '3110', accountName: 'Capital / Investment', accountType: 'Equity', normalBalance: 'Credit' },
  { _id: 'a6', accountCode: '4110', accountName: 'Sales',                accountType: 'Revenue', normalBalance: 'Credit' },
]);

beforeEach(() => jest.clearAllMocks());

describe('importAccountResolution.resolveForImport', () => {
  it('resolves an exact name without creating anything', async () => {
    const r = await svc.resolveForImport(BIZ, COA(), 'Cash at Bank', { side: 'debit' });
    expect(r.account._id).toBe('a1');
    expect(r.created).toBe(false);
    expect(ChartOfAccount.create).not.toHaveBeenCalled();
  });

  it('resolves Owner Equity via the synonym table (the reported bug)', async () => {
    const r = await svc.resolveForImport(BIZ, COA(), 'Owner Equity', { side: 'credit', transactionType: 'Owner Investment' });
    expect(r.account._id).toBe('a4');
    expect(r.created).toBe(false);
    expect(r.how).toBe('synonym');
  });

  it('resolves an account-code cell', async () => {
    const r = await svc.resolveForImport(BIZ, COA(), '4110', { side: 'credit' });
    expect(r.account._id).toBe('a6');
    expect(r.how).toBe('code');
  });

  it('auto-creates a genuinely new account with inferred shape and next code', async () => {
    ChartOfAccount.create.mockImplementation(async (doc) => ({ _id: 'new1', ...doc }));
    const accounts = COA();
    const r = await svc.resolveForImport(BIZ, accounts, 'Drone Fleet Maintenance', { side: 'debit', transactionType: 'Expense' });
    expect(r.created).toBe(true);
    expect(r.how).toBe('created');
    expect(ChartOfAccount.create).toHaveBeenCalledWith(expect.objectContaining({
      businessId: BIZ,
      accountName: 'Drone Fleet Maintenance',
      accountType: 'Expense',
      normalBalance: 'Debit',
      accountCode: '6110',        // first code in an empty 6xxx range
      autoCreated: true,
      isDefault: false,
    }));
    // pushed into the in-memory list so later rows in the same batch reuse it
    expect(accounts.some((a) => a._id === 'new1')).toBe(true);
  });

  it('reuses (not duplicates) an account it created earlier in the same batch', async () => {
    ChartOfAccount.create.mockImplementation(async (doc) => ({ _id: 'new1', ...doc }));
    const accounts = COA();
    await svc.resolveForImport(BIZ, accounts, 'Drone Fleet Maintenance', { side: 'debit' });
    const r2 = await svc.resolveForImport(BIZ, accounts, 'Drone Fleet Maintenance', { side: 'debit' });
    expect(r2.created).toBe(false);
    expect(ChartOfAccount.create).toHaveBeenCalledTimes(1);
  });

  it('refuses to create from junk names (too short / numeric-only)', async () => {
    const r1 = await svc.resolveForImport(BIZ, COA(), 'ab', { side: 'debit' });
    const r2 = await svc.resolveForImport(BIZ, COA(), '12345678', { side: 'debit' });
    expect(r1.account).toBeNull();
    expect(r2.account).toBeNull();
    expect(ChartOfAccount.create).not.toHaveBeenCalled();
  });

  it('respects allowCreate=false (resolve-only mode for previews)', async () => {
    const r = await svc.resolveForImport(BIZ, COA(), 'Drone Fleet Maintenance', { side: 'debit', allowCreate: false });
    expect(r.account).toBeNull();
    expect(r.wouldCreate).toEqual(expect.objectContaining({ accountType: 'Expense' }));
    expect(ChartOfAccount.create).not.toHaveBeenCalled();
  });

  it('survives a duplicate-key race by re-resolving instead of failing the row', async () => {
    const err = new Error('E11000 duplicate key'); err.code = 11000;
    ChartOfAccount.create.mockRejectedValue(err);
    const accounts = COA();
    // simulate the account appearing concurrently (another request created it)
    const refreshed = [...COA(), { _id: 'race1', accountCode: '6110', accountName: 'Drone Fleet Maintenance', accountType: 'Expense', normalBalance: 'Debit' }];
    const r = await svc.resolveForImport(BIZ, accounts, 'Drone Fleet Maintenance', {
      side: 'debit', refreshAccounts: async () => refreshed,
    });
    expect(r.account._id).toBe('race1');
    expect(r.created).toBe(false);
  });
});

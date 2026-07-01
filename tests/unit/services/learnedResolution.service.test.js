'use strict';
jest.mock('../../../services/entityMemory.service', () => ({ learn: jest.fn(), suggest: jest.fn() }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const entityMemory = require('../../../services/entityMemory.service');
const svc = require('../../../services/learnedResolution.service');
const BIZ = '507f1f77bcf86cd799439099';

beforeEach(() => jest.clearAllMocks());

describe('learnAccountsFromConfirmation', () => {
  it('learns the description → accounts mapping under a normalized key', async () => {
    entityMemory.learn.mockResolvedValue({});
    await svc.learnAccountsFromConfirmation(BIZ, 'Paid electricity bill 5000', {
      debitAccountName: 'Utilities Expense', creditAccountName: 'Cash',
    });
    expect(entityMemory.learn).toHaveBeenCalledWith(
      BIZ, 'nl_description_accounts', 'paid electricity bill',
      { debitAccountName: 'Utilities Expense', creditAccountName: 'Cash' },
    );
  });

  it('is a no-op when the key is unlearnable or account names are missing', async () => {
    await svc.learnAccountsFromConfirmation(BIZ, '5000 $$$', { debitAccountName: 'X', creditAccountName: 'Y' });
    await svc.learnAccountsFromConfirmation(BIZ, 'Paid rent', { debitAccountName: '', creditAccountName: 'Cash' });
    expect(entityMemory.learn).not.toHaveBeenCalled();
  });

  it('never throws even if the memory store fails', async () => {
    entityMemory.learn.mockRejectedValue(new Error('db down'));
    await expect(
      svc.learnAccountsFromConfirmation(BIZ, 'Paid electricity bill', { debitAccountName: 'A', creditAccountName: 'B' }),
    ).resolves.toBeUndefined();
  });
});

describe('recallAccounts', () => {
  it('returns the learned mapping for a matching normalized key', async () => {
    entityMemory.suggest.mockResolvedValue({ value: { debitAccountName: 'Utilities Expense', creditAccountName: 'Cash' }, hits: 4 });
    const r = await svc.recallAccounts(BIZ, 'Paid electricity bill Rs 6,200 on 2025-01-15');
    expect(entityMemory.suggest).toHaveBeenCalledWith(BIZ, 'nl_description_accounts', 'paid electricity bill');
    expect(r).toEqual({ debitAccountName: 'Utilities Expense', creditAccountName: 'Cash', hits: 4 });
  });

  it('returns null when nothing is learned', async () => {
    entityMemory.suggest.mockResolvedValue(null);
    expect(await svc.recallAccounts(BIZ, 'Some novel description')).toBeNull();
  });

  it('returns null (and does not query) for an unlearnable key', async () => {
    expect(await svc.recallAccounts(BIZ, '5000 $$$')).toBeNull();
    expect(entityMemory.suggest).not.toHaveBeenCalled();
  });

  it('never throws — a store failure yields null', async () => {
    entityMemory.suggest.mockRejectedValue(new Error('boom'));
    expect(await svc.recallAccounts(BIZ, 'Paid electricity bill')).toBeNull();
  });
});

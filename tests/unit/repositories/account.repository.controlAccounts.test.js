// tests/unit/repositories/account.repository.controlAccounts.test.js
'use strict';
jest.mock('../../../models/ChartOfAccount.model', () => {
  const m = function () {};
  m.find = jest.fn();
  m.insertMany = jest.fn();
  m.updateMany = jest.fn();
  return m;
});

const ChartOfAccount = require('../../../models/ChartOfAccount.model');
const accountRepository = require('../../../repositories/account.repository');
const { CONTROL_ACCOUNT_CODES, DEFAULT_ACCOUNTS } = require('../../../config/constants');

const BIZ = '507f1f77bcf86cd799439099';

describe('account.repository — control-account backfill (syncMissingDefaults)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Every DEFAULT_ACCOUNTS code already exists — isolates the test to the
    // backfill pass (no insertMany involved).
    ChartOfAccount.find.mockReturnValue({
      lean: () => Promise.resolve(DEFAULT_ACCOUNTS.map(a => ({ accountCode: a.accountCode }))),
    });
    ChartOfAccount.updateMany.mockResolvedValue({ modifiedCount: CONTROL_ACCOUNT_CODES.length });
  });

  test('flags every known control-account code as isControlAccount:true for the business', async () => {
    await accountRepository.syncMissingDefaults(BIZ);
    expect(ChartOfAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: expect.anything(),
        isControlAccount: { $ne: true },
        $or: expect.arrayContaining([
          expect.objectContaining({ accountCode: expect.objectContaining({ $in: expect.arrayContaining(CONTROL_ACCOUNT_CODES) }) }),
        ]),
      }),
      { $set: { isControlAccount: true } }
    );
  });

  test('the control-account query also matches the tax-engine dynamic ranges (1170-1177, 2121-2130)', async () => {
    await accountRepository.syncMissingDefaults(BIZ);
    const call = ChartOfAccount.updateMany.mock.calls[0][0];
    const orClause = call.$or.find(c => c.accountCode?.$regex);
    expect(orClause).toBeTruthy();
    for (const code of ['1170', '1177', '2121', '2130']) {
      expect(orClause.accountCode.$regex.test(code)).toBe(true);
    }
    for (const code of ['1178', '2120', '2131']) {
      expect(orClause.accountCode.$regex.test(code)).toBe(false);
    }
  });
});

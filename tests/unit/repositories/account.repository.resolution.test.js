// tests/unit/repositories/account.repository.resolution.test.js
'use strict';
jest.mock('../../../models/ChartOfAccount.model', () => {
  const m = function () {};
  m.find = jest.fn();
  m.findOne = jest.fn();
  return m;
});

const ChartOfAccount = require('../../../models/ChartOfAccount.model');
const accountRepository = require('../../../repositories/account.repository');

const BIZ = '507f1f77bcf86cd799439099';

function mockAllAccounts(accounts) {
  ChartOfAccount.find.mockReturnValue({ lean: () => Promise.resolve(accounts) });
}

describe('account.repository — matcher-backed resolution', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('findByBusinessAndName (backward-compatible bare-account signature)', () => {
    test('returns a bare account on an exact match (existing callers keep working)', async () => {
      mockAllAccounts([{ _id: 'a1', accountName: 'Cash at Bank' }]);
      const result = await accountRepository.findByBusinessAndName(BIZ, 'cash at bank');
      expect(result).toEqual(expect.objectContaining({ _id: 'a1' }));
      // Bare account — no confidence wrapper leaking to existing callers.
      expect(result.confidence).toBeUndefined();
    });

    test('picks the tightest ambiguous match instead of document order (the bug fix)', async () => {
      mockAllAccounts([
        { _id: 'a7', accountName: 'Rent — Equipment & Machinery' },
        { _id: 'a8', accountName: 'Rent Office' },
      ]);
      const result = await accountRepository.findByBusinessAndName(BIZ, 'Rent');
      expect(result._id).toBe('a8');
    });

    test('returns null when nothing matches', async () => {
      mockAllAccounts([{ _id: 'a1', accountName: 'Cash at Bank' }]);
      const result = await accountRepository.findByBusinessAndName(BIZ, 'Totally Unrelated Xyzzy');
      expect(result).toBeNull();
    });
  });

  describe('resolveWithConfidence (new richer entry point)', () => {
    test('returns { account, confidence, matchType } for an exact match', async () => {
      mockAllAccounts([{ _id: 'a1', accountName: 'Cash at Bank' }]);
      const result = await accountRepository.resolveWithConfidence(BIZ, 'Cash at Bank');
      expect(result).toEqual({
        account: expect.objectContaining({ _id: 'a1' }),
        confidence: 1.0,
        matchType: 'exact',
      });
    });

    test('returns matchType none + confidence 0 when nothing matches', async () => {
      mockAllAccounts([{ _id: 'a1', accountName: 'Cash at Bank' }]);
      const result = await accountRepository.resolveWithConfidence(BIZ, 'Nonexistent Xyzzy');
      expect(result).toEqual({ account: null, confidence: 0, matchType: 'none' });
    });
  });
});

/**
 * tests/unit/services/taxEngine.resolveAccount.test.js
 *
 * Audit 2026-07-02 F11 — tax accounts must resolve by CODE, not only by a
 * name regex, and must self-heal.
 *
 * The posting path resolved tax journal accounts by accountName regex: rename
 * "GST Payable" and every tax line silently vanished from new entries. The
 * engine now resolves name → profile account CODE → (self-heal: seed the
 * country's tax accounts) → code again, and only then gives up.
 */
'use strict';

jest.mock('../../../models/ChartOfAccount.model', () => ({
  findOne: jest.fn(),
  create: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../../models/Business.model', () => ({ findById: jest.fn() }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ChartOfAccount = require('../../../models/ChartOfAccount.model');
const taxEngine = require('../../../services/taxEngine.service');
const { getProfile } = require('../../../config/countryTaxProfiles');

const BIZ = 'biz1';
// Use a REAL account from the PK profile so the name→code mapping is exercised.
const PK_TAX_ACCOUNT = (getProfile('PK').additionalAccounts || [])[0];

const lean = (v) => ({ lean: () => Promise.resolve(v) });

beforeEach(() => jest.clearAllMocks());

describe('taxEngine.resolveTaxAccountId', () => {
  test('resolves by exact name when the account exists', async () => {
    ChartOfAccount.findOne.mockReturnValue(lean({ _id: 'acc-by-name' }));

    const id = await taxEngine.resolveTaxAccountId(BIZ, PK_TAX_ACCOUNT.accountName, 'PK');

    expect(id).toBe('acc-by-name');
  });

  test('falls back to the profile account CODE when the name was changed', async () => {
    ChartOfAccount.findOne.mockImplementation((q) =>
      lean(q.accountCode === PK_TAX_ACCOUNT.accountCode ? { _id: 'acc-by-code' } : null)
    );

    const id = await taxEngine.resolveTaxAccountId(BIZ, PK_TAX_ACCOUNT.accountName, 'PK');

    expect(id).toBe('acc-by-code');
  });

  test('self-heals: seeds the tax accounts once and retries by code', async () => {
    let codeCalls = 0;
    ChartOfAccount.findOne.mockImplementation((q) => {
      if (q.accountCode === PK_TAX_ACCOUNT.accountCode) {
        codeCalls += 1;
        // First code lookup misses; after the seed pass it exists.
        return lean(codeCalls >= 2 ? { _id: 'acc-seeded' } : null);
      }
      // Name lookups and ensureTaxAccounts' own existence checks all miss.
      return q.accountName ? lean(null) : Promise.resolve(null);
    });

    const id = await taxEngine.resolveTaxAccountId(BIZ, PK_TAX_ACCOUNT.accountName, 'PK');

    expect(id).toBe('acc-seeded');
    expect(ChartOfAccount.create).toHaveBeenCalled(); // the seed pass ran
  });

  test('returns null for a name the country profile does not know', async () => {
    ChartOfAccount.findOne.mockReturnValue(lean(null));

    const id = await taxEngine.resolveTaxAccountId(BIZ, 'Totally Unknown Account', 'PK');

    expect(id).toBeNull();
  });
});

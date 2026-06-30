// tests/unit/services/transaction.inputHardening.test.js
//
// createTransaction is the single funnel for EVERY transaction input path —
// the Joi-validated UI form, but also NL-confirm, installment, batch, recurring
// and system-generated callers that bypass Joi and hand the service raw values.
// These tests harden that funnel against non-finite, over-precise, over-large and
// string amounts that would otherwise silently reach the ledger and break the
// "every journal entry must balance exactly" invariant (CLAUDE.md).

jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../services/audit.service');
jest.mock('../../../services/inventory.service');
jest.mock('../../../models/AccountingPeriod.model', () => ({
  findCoveringPeriod: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../models/InvoiceCounter.model', () => ({
  findOneAndUpdate: jest.fn().mockResolvedValue({ seq: 1 }),
}));

const transactionService = require('../../../services/transaction.service');
const transactionRepository = require('../../../repositories/transaction.repository');
const accountRepository = require('../../../repositories/account.repository');
const auditService = require('../../../services/audit.service');

const makeAccount = (id, normalBalance = 'Debit') => ({
  _id: id,
  normalBalance,
  accountName: id === 'acc001' ? 'Office Expense' : 'Cash',
  accountType: id === 'acc001' ? 'Expense' : 'Asset',
  runningBalance: 0,
});

const makeTx = (overrides = {}) => ({
  _id: 'tx001',
  businessId: 'biz001',
  transactionType: 'Expense',
  amount: 500,
  toObject() { return { ...this }; },
  ...overrides,
});

const VALID_DATA = {
  businessId: 'biz001',
  transactionDate: new Date().toISOString(),
  description: 'Office supplies',
  transactionType: 'Expense',
  amount: 1000,
  debitAccountId: 'acc001',
  creditAccountId: 'acc002',
  inputMethod: 'form',
  skipTax: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  auditService.logCreate = jest.fn().mockResolvedValue(undefined);
  accountRepository.findOneByBusinessAndId.mockImplementation((_b, accId) =>
    Promise.resolve(makeAccount(accId, accId === 'acc001' ? 'Debit' : 'Credit')));
  accountRepository.findById.mockImplementation((accId) =>
    Promise.resolve(makeAccount(accId, accId === 'acc001' ? 'Debit' : 'Credit')));
  accountRepository.findAllByBusinessAndIds.mockResolvedValue([]);
  accountRepository.updateRunningBalance.mockResolvedValue(undefined);
  // Echo entryData back so we can inspect exactly what would be persisted.
  transactionRepository.createTransaction.mockImplementation((entryData) =>
    Promise.resolve(makeTx({ ...entryData, _id: 'tx001' })));
});

describe('createTransaction — numeric input hardening', () => {
  test('rejects a non-finite amount (Infinity) with a clear 400', async () => {
    await expect(
      transactionService.createTransaction({ ...VALID_DATA, amount: Infinity }, 'u1', '127.0.0.1')
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/valid|finite|number/i) });
    expect(transactionRepository.createTransaction).not.toHaveBeenCalled();
  });

  test('rejects NaN amount with a clear 400 (not a misleading "missing fields")', async () => {
    await expect(
      transactionService.createTransaction({ ...VALID_DATA, amount: NaN }, 'u1', '127.0.0.1')
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/valid|number/i) });
  });

  test('rejects a non-numeric string amount with a clear 400', async () => {
    await expect(
      transactionService.createTransaction({ ...VALID_DATA, amount: 'abc' }, 'u1', '127.0.0.1')
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/valid|number/i) });
  });

  test('rejects an amount beyond the float-safe cap (1e20)', async () => {
    await expect(
      transactionService.createTransaction({ ...VALID_DATA, amount: 1e20 }, 'u1', '127.0.0.1')
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(transactionRepository.createTransaction).not.toHaveBeenCalled();
  });

  test('coerces a clean numeric string ("500") to the number 500', async () => {
    const tx = await transactionService.createTransaction(
      { ...VALID_DATA, amount: '500' }, 'u1', '127.0.0.1'
    );
    expect(tx.amount).toBe(500);
    const persisted = transactionRepository.createTransaction.mock.calls[0][0];
    // Every journal line amount must be a real number, never a string.
    for (const line of persisted.journalLines || []) {
      expect(typeof line.amount).toBe('number');
    }
  });

  test('rounds a sub-cent amount (100.999) to 2 decimals before posting', async () => {
    const tx = await transactionService.createTransaction(
      { ...VALID_DATA, amount: 100.999 }, 'u1', '127.0.0.1'
    );
    expect(tx.amount).toBe(101);
    const persisted = transactionRepository.createTransaction.mock.calls[0][0];
    for (const line of persisted.journalLines || []) {
      // No line may carry more than cent precision.
      expect(Math.round(line.amount * 100) / 100).toBe(line.amount);
    }
  });

  test('a 3-line compound entry with string amounts stays balanced (no concat bug)', async () => {
    // 600 debit split across two debit lines, 600 credit — classic compound entry.
    accountRepository.findAllByBusinessAndIds.mockResolvedValue([
      { _id: 'acc001' }, { _id: 'acc002' }, { _id: 'acc003' },
    ]);
    const data = {
      ...VALID_DATA,
      amount: undefined,
      journalLines: [
        { type: 'debit', accountId: 'acc001', amount: '400' },
        { type: 'debit', accountId: 'acc003', amount: '200' },
        { type: 'credit', accountId: 'acc002', amount: '600' },
      ],
    };
    const tx = await transactionService.createTransaction(data, 'u1', '127.0.0.1');
    expect(tx).toHaveProperty('_id');
    const persisted = transactionRepository.createTransaction.mock.calls[0][0];
    let d = 0, c = 0;
    for (const l of persisted.journalLines) {
      expect(typeof l.amount).toBe('number');
      if (l.type === 'debit') d += l.amount; else c += l.amount;
    }
    expect(Math.round(d * 100)).toBe(Math.round(c * 100));
  });

  test('rejects an invalid transactionDate', async () => {
    await expect(
      transactionService.createTransaction(
        { ...VALID_DATA, transactionDate: 'not-a-date' }, 'u1', '127.0.0.1'
      )
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/date/i) });
  });
});

describe('createTransaction — journal-line structural hardening', () => {
  const threeAccounts = [{ _id: 'acc001' }, { _id: 'acc002' }, { _id: 'acc003' }];

  test('normalizes a wrong-case line type ("Debit"/"CREDIT") to canonical lowercase', async () => {
    accountRepository.findAllByBusinessAndIds.mockResolvedValue(threeAccounts);
    const tx = await transactionService.createTransaction({
      ...VALID_DATA,
      amount: undefined,
      journalLines: [
        { type: 'Debit',  accountId: 'acc001', amount: 600 },
        { type: 'CREDIT', accountId: 'acc002', amount: 600 },
      ],
    }, 'u1', '127.0.0.1');
    expect(tx).toHaveProperty('_id');
    const persisted = transactionRepository.createTransaction.mock.calls[0][0];
    // Stored types MUST be canonical so report aggregation (which keys on exact
    // 'debit'/'credit') and the ledger posting both see the line.
    for (const l of persisted.journalLines) {
      expect(['debit', 'credit']).toContain(l.type);
    }
  });

  test('rejects a line with an unrecognized type ("dr") with a clear 400', async () => {
    accountRepository.findAllByBusinessAndIds.mockResolvedValue(threeAccounts);
    await expect(transactionService.createTransaction({
      ...VALID_DATA,
      amount: undefined,
      journalLines: [
        { type: 'dr', accountId: 'acc001', amount: 600 },
        { type: 'credit', accountId: 'acc002', amount: 600 },
      ],
    }, 'u1', '127.0.0.1')).rejects.toMatchObject({
      statusCode: 400, message: expect.stringMatching(/debit|credit|type/i),
    });
    expect(transactionRepository.createTransaction).not.toHaveBeenCalled();
  });

  test('rejects a line missing accountId with a clear 400 (not a later 500)', async () => {
    accountRepository.findAllByBusinessAndIds.mockResolvedValue(threeAccounts);
    await expect(transactionService.createTransaction({
      ...VALID_DATA,
      amount: undefined,
      journalLines: [
        { type: 'debit',  amount: 600 },             // no accountId
        { type: 'credit', accountId: 'acc002', amount: 600 },
      ],
    }, 'u1', '127.0.0.1')).rejects.toMatchObject({ statusCode: 400 });
    expect(transactionRepository.createTransaction).not.toHaveBeenCalled();
  });

  test('two mis-cased legs can no longer pass the 0===0 balance check as a no-op entry', async () => {
    accountRepository.findAllByBusinessAndIds.mockResolvedValue(threeAccounts);
    // Before hardening: both 'Debit'/'Credit' → debits=0,credits=0 → balance "passes"
    // → a journal entry with zero ledger effect is created. After normalization the
    // legs are counted, so this is a real, balanced 600/600 entry that actually posts.
    const tx = await transactionService.createTransaction({
      ...VALID_DATA,
      amount: undefined,
      journalLines: [
        { type: 'Debit',  accountId: 'acc001', amount: 600 },
        { type: 'Credit', accountId: 'acc002', amount: 600 },
      ],
    }, 'u1', '127.0.0.1');
    const persisted = transactionRepository.createTransaction.mock.calls[0][0];
    let d = 0, c = 0;
    for (const l of persisted.journalLines) {
      if (l.type === 'debit') d += l.amount; else if (l.type === 'credit') c += l.amount;
    }
    expect(d).toBe(600);
    expect(c).toBe(600);
  });
});

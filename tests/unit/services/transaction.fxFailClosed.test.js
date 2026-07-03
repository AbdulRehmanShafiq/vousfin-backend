/**
 * tests/unit/services/transaction.fxFailClosed.test.js
 *
 * Audit 2026-07-02 F10 — a foreign-currency transaction whose exchange-rate
 * resolution FAILS must be rejected, not silently posted at 1:1.
 *
 * The old catch logged a warning and "continued with the raw amount": a USD
 * 100 entry with an FX-service hiccup posted 100 PKR to the ledger — silent
 * corruption of the base-currency books. Correctness over convenience: refuse
 * the posting and tell the user to retry or supply a rate.
 */
'use strict';

jest.mock('../../../utils/withTransaction', () => ({
  withTransaction: jest.fn((fn) => fn(null)),
}));
jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../services/audit.service');
jest.mock('../../../services/fx.service', () => ({
  prepareFxFields: jest.fn(),
}));
jest.mock('../../../services/taxEngine.service', () => ({
  isTaxEnabled: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../../models/AccountingPeriod.model', () => ({
  findCoveringPeriod: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../models/InvoiceCounter.model', () => ({
  findOneAndUpdate: jest.fn().mockResolvedValue({ seq: 1 }),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const transactionService = require('../../../services/transaction.service');
const transactionRepository = require('../../../repositories/transaction.repository');
const accountRepository = require('../../../repositories/account.repository');
const fxService = require('../../../services/fx.service');

const DATA = {
  businessId: 'biz1',
  transactionDate: new Date().toISOString(),
  description: 'USD expense',
  transactionType: 'Expense',
  amount: 100,
  currencyCode: 'USD',
  debitAccountId: 'accD',
  creditAccountId: 'accC',
  inputMethod: 'form',
};

beforeEach(() => {
  jest.clearAllMocks();
  accountRepository.findOneByBusinessAndId.mockImplementation((_b, id) =>
    Promise.resolve({ _id: id, normalBalance: 'Debit', accountName: 'X', accountType: 'Expense' })
  );
  transactionRepository.createTransaction.mockResolvedValue({ _id: 'tx1', toObject: () => ({}) });
});

describe('F10 — FX resolution failures fail CLOSED', () => {
  test('rejects the posting when prepareFxFields throws — nothing persists', async () => {
    fxService.prepareFxFields.mockRejectedValue(new Error('rate provider down'));

    await expect(
      transactionService.createTransaction({ ...DATA }, 'u1', '127.0.0.1')
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(transactionRepository.createTransaction).not.toHaveBeenCalled();
  });

  test('posts normally when FX fields resolve', async () => {
    fxService.prepareFxFields.mockResolvedValue({
      currencyCode: 'USD', exchangeRate: 280, baseCurrencyAmount: 28000,
    });
    accountRepository.findById = jest.fn().mockResolvedValue({ _id: 'accD', normalBalance: 'Debit' });
    accountRepository.updateRunningBalance = jest.fn().mockResolvedValue(undefined);
    const auditService = require('../../../services/audit.service');
    auditService.logCreate = jest.fn().mockResolvedValue(undefined);

    const tx = await transactionService.createTransaction({ ...DATA }, 'u1', '127.0.0.1');
    expect(tx._id).toBe('tx1');
  });
});

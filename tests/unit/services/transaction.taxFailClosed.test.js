/**
 * tests/unit/services/transaction.taxFailClosed.test.js
 *
 * Audit 2026-07-02 F11 — tax failures fail CLOSED.
 *
 * Two silent-degradation paths existed on taxable transactions:
 *   1. any tax-engine error was swallowed ("continuing without tax") — a
 *      taxable sale posted with NO tax, invisible until the filing;
 *   2. a tax journal line whose account could not be resolved was silently
 *      dropped ("skipping tax line").
 * Both now refuse the posting: wrong filings are worse than a retry.
 */
'use strict';

jest.mock('../../../utils/withTransaction', () => ({
  withTransaction: jest.fn((fn) => fn(null)),
}));
jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../services/audit.service');
jest.mock('../../../services/taxEngine.service', () => ({
  isTaxEnabled: jest.fn(),
  getBusinessTaxConfig: jest.fn().mockResolvedValue({ config: { country: 'PK' } }),
  shouldApplyReverseCharge: jest.fn().mockReturnValue(false),
  resolveApplicableTaxes: jest.fn(),
  generateTaxJournalLines: jest.fn(),
  resolveTaxAccountId: jest.fn(),
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
const taxEngine = require('../../../services/taxEngine.service');
const auditService = require('../../../services/audit.service');

const DATA = {
  businessId: 'biz1',
  transactionDate: new Date().toISOString(),
  description: 'Taxable sale',
  transactionType: 'Cash Sale',
  amount: 118,
  debitAccountId: 'accCASH',
  creditAccountId: 'accREV',
  inputMethod: 'form',
};

const GST_RESULT = {
  taxApplied: true,
  totalTax: 18,
  countryCode: 'PK',
  lines: [{ taxType: 'GST', rate: 18, taxAmount: 18, isWithholding: false }],
};

beforeEach(() => {
  jest.clearAllMocks();
  auditService.logCreate = jest.fn().mockResolvedValue(undefined);
  accountRepository.findOneByBusinessAndId.mockImplementation((_b, id) =>
    Promise.resolve({ _id: id, normalBalance: 'Debit', accountName: 'X', accountType: id === 'accREV' ? 'Revenue' : 'Asset' })
  );
  accountRepository.findById.mockResolvedValue({ _id: 'a', normalBalance: 'Debit' });
  accountRepository.updateRunningBalance.mockResolvedValue(undefined);
  transactionRepository.createTransaction.mockResolvedValue({ _id: 'tx1', toObject: () => ({}) });
  taxEngine.isTaxEnabled.mockResolvedValue(true);
});

describe('F11 — tax failures on taxable transactions fail closed', () => {
  test('a tax-engine error refuses the posting instead of posting untaxed', async () => {
    taxEngine.resolveApplicableTaxes.mockRejectedValue(new Error('schedule table corrupt'));

    await expect(
      transactionService.createTransaction({ ...DATA }, 'u1', '127.0.0.1')
    ).rejects.toMatchObject({ statusCode: 500 });

    expect(transactionRepository.createTransaction).not.toHaveBeenCalled();
  });

  test('an unresolvable tax account refuses the posting instead of dropping the tax line', async () => {
    taxEngine.resolveApplicableTaxes.mockResolvedValue(GST_RESULT);
    taxEngine.generateTaxJournalLines.mockReturnValue({
      lines: [
        { account: 'Sales Revenue', debit: 0, credit: 100, memo: 'net' },
        { account: 'GST Payable', debit: 0, credit: 18, memo: 'output tax' },
      ],
    });
    taxEngine.resolveTaxAccountId.mockResolvedValue(null); // rename + seed both failed

    await expect(
      transactionService.createTransaction({ ...DATA }, 'u1', '127.0.0.1')
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(transactionRepository.createTransaction).not.toHaveBeenCalled();
  });

  test('resolvable tax accounts post the tax lines normally', async () => {
    taxEngine.resolveApplicableTaxes.mockResolvedValue(GST_RESULT);
    taxEngine.generateTaxJournalLines.mockReturnValue({
      lines: [
        { account: 'Sales Revenue', debit: 18, credit: 0, memo: 'reclass' },
        { account: 'GST Payable', debit: 0, credit: 18, memo: 'output tax' },
      ],
    });
    taxEngine.resolveTaxAccountId.mockResolvedValue('taxAcc1');

    const tx = await transactionService.createTransaction({ ...DATA }, 'u1', '127.0.0.1');

    expect(tx._id).toBe('tx1');
    const persisted = transactionRepository.createTransaction.mock.calls[0][0];
    const taxLine = (persisted.journalLines || []).find((l) => l.accountId === 'taxAcc1' && l.type === 'credit');
    expect(taxLine).toMatchObject({ amount: 18 });
  });

  test('a business without tax enabled is completely unaffected', async () => {
    taxEngine.isTaxEnabled.mockResolvedValue(false);

    const tx = await transactionService.createTransaction({ ...DATA }, 'u1', '127.0.0.1');

    expect(tx._id).toBe('tx1');
    expect(taxEngine.resolveApplicableTaxes).not.toHaveBeenCalled();
  });
});

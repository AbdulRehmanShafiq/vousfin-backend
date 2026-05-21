// tests/unit/services/transaction.service.test.js
// Mocks all repositories and audit service so no DB needed.

jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../services/audit.service');

const transactionService = require('../../../services/transaction.service');
const transactionRepository = require('../../../repositories/transaction.repository');
const accountRepository = require('../../../repositories/account.repository');
const auditService = require('../../../services/audit.service');
const { ApiError } = require('../../../utils/ApiError');

// ── Helpers ────────────────────────────────────────────────────────────────────
const makeAccount = (id, normalBalance = 'Debit') => ({
  _id: id,
  normalBalance,
  accountName: 'Test Account',
  runningBalance: 0,
});

const makeTx = (overrides = {}) => ({
  _id: 'tx001',
  businessId: 'biz001',
  transactionDate: new Date(),
  description: 'Test transaction',
  transactionType: 'Expense',
  amount: 500,
  debitAccountId: { _id: 'acc001' },
  creditAccountId: { _id: 'acc002' },
  inputMethod: 'form',
  status: 'posted',
  toObject: function () { return { ...this }; },
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
};

beforeEach(() => {
  jest.clearAllMocks();
  auditService.logCreate = jest.fn().mockResolvedValue(undefined);
  auditService.logUpdate = jest.fn().mockResolvedValue(undefined);
  auditService.logReversal = jest.fn().mockResolvedValue(undefined);
  auditService.getAuditTrail = jest.fn().mockResolvedValue({ data: [] });

  accountRepository.findOneByBusinessAndId
    .mockImplementation((_bizId, accId) =>
      Promise.resolve(makeAccount(accId, accId === 'acc001' ? 'Debit' : 'Credit'))
    );
  accountRepository.findById
    .mockImplementation(accId =>
      Promise.resolve(makeAccount(accId, accId === 'acc001' ? 'Debit' : 'Credit'))
    );
  accountRepository.updateRunningBalance.mockResolvedValue(undefined);
  transactionRepository.createTransaction.mockResolvedValue(makeTx());
});

// ── createTransaction ──────────────────────────────────────────────────────────
describe('TransactionService.createTransaction()', () => {
  test('should throw 400 when required fields are missing', async () => {
    const incomplete = { ...VALID_DATA, businessId: undefined };
    await expect(transactionService.createTransaction(incomplete, 'user1', '127.0.0.1'))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('should throw 400 when amount is zero', async () => {
    await expect(
      transactionService.createTransaction({ ...VALID_DATA, amount: 0 }, 'user1', '127.0.0.1')
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('should throw 400 when amount is negative', async () => {
    await expect(
      transactionService.createTransaction({ ...VALID_DATA, amount: -100 }, 'user1', '127.0.0.1')
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('should throw 400 when debit and credit accounts are the same', async () => {
    await expect(
      transactionService.createTransaction(
        { ...VALID_DATA, debitAccountId: 'acc001', creditAccountId: 'acc001' },
        'user1',
        '127.0.0.1'
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('should throw 400 when accounts do not belong to business', async () => {
    accountRepository.findOneByBusinessAndId.mockResolvedValue(null);
    await expect(
      transactionService.createTransaction(VALID_DATA, 'user1', '127.0.0.1')
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('should create transaction and return it on success', async () => {
    const tx = await transactionService.createTransaction(VALID_DATA, 'user1', '127.0.0.1');
    expect(transactionRepository.createTransaction).toHaveBeenCalledTimes(1);
    expect(tx).toHaveProperty('_id');
  });

  test('should call auditService.logCreate after creation', async () => {
    await transactionService.createTransaction(VALID_DATA, 'user1', '127.0.0.1');
    expect(auditService.logCreate).toHaveBeenCalledTimes(1);
  });

  test('should call updateRunningBalance for both accounts', async () => {
    await transactionService.createTransaction(VALID_DATA, 'user1', '127.0.0.1');
    // _updateAccountBalance is called twice (debit + credit), each calls updateRunningBalance
    expect(accountRepository.updateRunningBalance).toHaveBeenCalledTimes(2);
  });
});

// ── getTransactionById ─────────────────────────────────────────────────────────
describe('TransactionService.getTransactionById()', () => {
  test('should throw 404 if transaction not found', async () => {
    transactionRepository.findByIdWithDetails.mockResolvedValue(null);
    await expect(transactionService.getTransactionById('bad-id', 'biz001'))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  test('should return transaction with auditTrail on success', async () => {
    transactionRepository.findByIdWithDetails.mockResolvedValue(makeTx());
    const result = await transactionService.getTransactionById('tx001', 'biz001');
    expect(result).toHaveProperty('auditTrail');
  });
});

// ── deleteTransaction ──────────────────────────────────────────────────────────
describe('TransactionService.deleteTransaction()', () => {
  test('should throw 404 if transaction not found', async () => {
    transactionRepository.findByIdWithDetails.mockResolvedValue(null);
    await expect(transactionService.deleteTransaction('bad', 'biz001', 'user1', '127.0.0.1'))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  test('should throw 400 if transaction already reversed', async () => {
    transactionRepository.findByIdWithDetails.mockResolvedValue(makeTx({ status: 'reversed' }));
    await expect(transactionService.deleteTransaction('tx001', 'biz001', 'user1', '127.0.0.1'))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('should create reversal and return it on success', async () => {
    const original = makeTx();
    transactionRepository.findByIdWithDetails.mockResolvedValue(original);
    const reversalTx = makeTx({ _id: 'tx_rev', description: 'Reversal of: Test transaction' });
    transactionRepository.createTransaction.mockResolvedValue(reversalTx);
    transactionRepository.updateTransaction.mockResolvedValue({ status: 'reversed' });

    const result = await transactionService.deleteTransaction('tx001', 'biz001', 'user1', '127.0.0.1');
    expect(result._id).toBe('tx_rev');
    expect(transactionRepository.updateTransaction).toHaveBeenCalledWith(
      'tx001', 'biz001', { status: 'reversed', paymentStatus: null, remainingBalance: 0 }
    );
  });
});

// ── createBulkTransactions ─────────────────────────────────────────────────────
describe('TransactionService.createBulkTransactions()', () => {
  test('should return successful count and failed array', async () => {
    const entries = [
      { ...VALID_DATA },
      { ...VALID_DATA, amount: 0 }, // will fail
    ];
    const result = await transactionService.createBulkTransactions(entries, 'user1', '127.0.0.1');
    expect(result.successful).toBe(1);
    expect(result.failed).toHaveLength(1);
  });

  test('should return all successful when all entries are valid', async () => {
    const entries = [VALID_DATA, VALID_DATA];
    const result = await transactionService.createBulkTransactions(entries, 'user1', '127.0.0.1');
    expect(result.successful).toBe(2);
    expect(result.failed).toHaveLength(0);
  });
});

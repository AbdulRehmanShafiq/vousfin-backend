// tests/unit/services/transaction.service.test.js
// Mocks all repositories and audit service so no DB needed.

jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../services/audit.service');
// ERP refactor Step 3 — stub inventory.service so the purchase-side stock mirror
// (section "7a" of createTransaction) can be asserted without touching a DB.
jest.mock('../../../services/inventory.service');
// F11 made tax failures fail CLOSED, so the real taxEngine (whose config read
// needs a DB) must be stubbed to "tax not enabled" for these tax-free cases.
jest.mock('../../../services/taxEngine.service', () => ({
  isTaxEnabled: jest.fn().mockResolvedValue(false),
}));
// Phase 5.1 added an accounting-period lock check that queries a real Mongoose
// model with the businessId. In unit tests there is no DB and the fixtures use a
// non-ObjectId businessId, so stub the period lookup to "no covering period".
jest.mock('../../../models/AccountingPeriod.model', () => ({
  findCoveringPeriod: jest.fn().mockResolvedValue(null),
}));
// Cycle-2 hardening replaced random invoice numbers with an atomic InvoiceCounter
// sequence — a real Mongoose model, so stub it for unit tests (no DB available).
jest.mock('../../../models/InvoiceCounter.model', () => ({
  findOneAndUpdate: jest.fn().mockResolvedValue({ seq: 1 }),
}));
// Phase 8 — the purchase path reads the item to see whether it is standard-costed
// (and therefore needs a purchase price variance leg). These fixtures are not.
jest.mock('../../../repositories/inventoryItem.repository', () => ({
  model: { findOne: jest.fn().mockResolvedValue(null), create: jest.fn() },
}));

const transactionService = require('../../../services/transaction.service');
const transactionRepository = require('../../../repositories/transaction.repository');
const accountRepository = require('../../../repositories/account.repository');
const auditService = require('../../../services/audit.service');
const inventoryService = require('../../../services/inventory.service');
const { ApiError } = require('../../../utils/ApiError');

// ── Helpers ────────────────────────────────────────────────────────────────────
const makeAccount = (id, normalBalance = 'Debit', overrides = {}) => ({
  _id: id,
  normalBalance,
  accountName: 'Test Account',
  runningBalance: 0,
  ...overrides,
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

// ── isControlAccount is metadata-only — NOT a posting block ────────────────────
// AR (1110), AP (2110), and tax-payable accounts are flagged `isControlAccount`
// for reporting/future reconciliation tooling, but VousFin has no per-customer
// AR/AP sub-accounts — Credit Sale, Payment Received, Credit Purchase, Payment
// Made, GST Payment, and WHT Payment are everyday transaction types that MUST
// post directly to these exact accounts (confirmed against the frontend's
// accountFilterRules.js, which routes them there deliberately). A blanket
// "block direct posting to control accounts" restriction was considered and
// rejected — it would have broken these core, everyday flows.
describe('TransactionService.createTransaction() — control accounts remain directly postable', () => {
  test('Credit Sale still posts directly to a control-flagged AR account', async () => {
    accountRepository.findOneByBusinessAndId.mockImplementation((_bizId, accId) =>
      Promise.resolve(
        accId === 'acc001'
          ? makeAccount(accId, 'Debit', { isControlAccount: true, accountName: 'Accounts Receivable' })
          : makeAccount(accId, 'Credit', { accountType: 'Revenue' })
      )
    );
    const tx = await transactionService.createTransaction(
      { ...VALID_DATA, transactionType: 'Credit Sale' }, 'user1', '127.0.0.1'
    );
    expect(tx).toHaveProperty('_id');
  });

  test('a compound journalLines entry touching a control-flagged account still posts (no block)', async () => {
    accountRepository.findAllByBusinessAndIds.mockResolvedValue([
      { _id: 'acc001' },
      { _id: 'acc003', isControlAccount: true },
    ]);
    const tx = await transactionService.createTransaction(
      {
        ...VALID_DATA,
        journalLines: [
          { accountId: 'acc001', type: 'debit', amount: 500 },
          { accountId: 'acc003', type: 'credit', amount: 500 },
        ],
      },
      'user1', '127.0.0.1'
    );
    expect(tx).toHaveProperty('_id');
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
    // The reversal also stamps metadata.reversalId on the original for auditability.
    // The 4th arg is the transaction session (audit A9 — all reversal writes are now
    // joined to one withTransaction; null under the standalone unit-test runtime).
    expect(transactionRepository.updateTransaction).toHaveBeenCalledWith(
      'tx001', 'biz001', expect.objectContaining({
        status: 'reversed', paymentStatus: null, remainingBalance: 0,
        metadata: expect.objectContaining({ reversalId: 'tx_rev' }),
      }), null
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

// ── Inventory purchase-side stock mirror (ERP refactor Step 3) ───────────────────
describe('TransactionService.createTransaction() — inventory purchase mirror', () => {
  const PURCHASE_DATA = {
    ...VALID_DATA,
    transactionType: 'Inventory Purchase',
    amount: 500,
    inventoryItemId: 'item001',
    inventoryQty: 5,
    skipTax: true, // bypass the tax engine for a focused assertion
  };

  test('auto-increments stock via inventoryService.applyPurchaseStock', async () => {
    await transactionService.createTransaction(PURCHASE_DATA, 'user1', '127.0.0.1');
    expect(inventoryService.applyPurchaseStock).toHaveBeenCalledTimes(1);
    // amount 500 / qty 5 = 100 inferred cost per unit
    expect(inventoryService.applyPurchaseStock).toHaveBeenCalledWith(
      'biz001', 'item001', 5, 100, expect.objectContaining({ userId: 'user1' })
    );
  });

  test('uses explicit unitCostPrice when provided (not the inferred average)', async () => {
    await transactionService.createTransaction(
      { ...PURCHASE_DATA, unitCostPrice: 90 }, 'user1', '127.0.0.1'
    );
    expect(inventoryService.applyPurchaseStock).toHaveBeenCalledWith(
      'biz001', 'item001', 5, 90, expect.objectContaining({ userId: 'user1' })
    );
  });

  test('skips the mirror when skipInventorySync is set (caller already incremented)', async () => {
    await transactionService.createTransaction(
      { ...PURCHASE_DATA, skipInventorySync: true }, 'user1', '127.0.0.1'
    );
    expect(inventoryService.applyPurchaseStock).not.toHaveBeenCalled();
  });

  test('does NOT mirror stock for a non-purchase transaction type', async () => {
    await transactionService.createTransaction(
      { ...PURCHASE_DATA, transactionType: 'Expense' }, 'user1', '127.0.0.1'
    );
    expect(inventoryService.applyPurchaseStock).not.toHaveBeenCalled();
  });
});

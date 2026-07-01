// tests/unit/controllers/transaction.controller.test.js
jest.mock('../../../services/transaction.service');
jest.mock('../../../services/nlParser/services/parserService');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../repositories/business.repository', () => ({
  findById: jest.fn().mockResolvedValue({ aiSettings: { autoPostEnabled: false } }),
}));
jest.mock('../../../utils/excelParser.utils');
jest.mock('../../../services/batchPosting.service', () => ({
  postBatch: jest.fn().mockResolvedValue({ posted: 0, pending: 0, failed: [], batchId: 'batch1' }),
}));
// createFormTransaction routes through the approval gate; its evaluate() reads
// the real Business model. Stub it to "approval disabled → post directly" so the
// controller delegates straight to the (mocked) transaction service.
jest.mock('../../../services/approval.service', () => ({
  submitOrPost: jest.fn(async (data, actor, ip) => ({
    pendingApproval: false,
    transaction: await require('../../../services/transaction.service')
      .createTransaction(data, actor.id, ip),
  })),
}));
jest.mock('../../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const transactionController = require('../../../controllers/transaction.controller');
const transactionService    = require('../../../services/transaction.service');
const parserService         = require('../../../services/nlParser/services/parserService');
const businessRepository    = require('../../../repositories/business.repository');
const approvalService       = require('../../../services/approval.service');
const accountRepository     = require('../../../repositories/account.repository');
const batchPostingService   = require('../../../services/batchPosting.service');
const { ApiError }          = require('../../../utils/ApiError');

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
};
const mockNext = jest.fn();

const reqWithUser = (body = {}, query = {}, params = {}) => ({
  body,
  query,
  params,
  ip: '127.0.0.1',
  user: { id: 'user1', businessId: 'biz001' },
});

beforeEach(() => jest.clearAllMocks());

// ── createFormTransaction ──────────────────────────────────────────────────────
describe('transactionController.createFormTransaction()', () => {
  test('should call transactionService.createTransaction and return 201', async () => {
    transactionService.createTransaction.mockResolvedValue({ _id: 'tx1' });
    const req = reqWithUser({ amount: 500, debitAccountId: 'a1', creditAccountId: 'a2' });
    const res = mockRes();

    await transactionController.createFormTransaction(req, res, mockNext);
    expect(transactionService.createTransaction).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('should call next(error) on service failure', async () => {
    transactionService.createTransaction.mockRejectedValue(new ApiError(400, 'Bad input'));
    const req = reqWithUser({});
    const res = mockRes();

    await transactionController.createFormTransaction(req, res, mockNext);
    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });
});

// ── processNaturalLanguage ────────────────────────────────────────────────────
describe('transactionController.processNaturalLanguage()', () => {
  test('should throw 400 when text is too short', async () => {
    const req = reqWithUser({ text: 'hi' });
    const res = mockRes();

    await transactionController.processNaturalLanguage(req, res, mockNext);
    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  test('should return parsed preview on valid text', async () => {
    parserService.parseTransaction.mockResolvedValue({
      success: true,
      parsedData: {
        amount: 1000,
        date: '2025-01-15',
        transactionType: 'Expense',
        description: 'Electricity bill',
        intent: 'Paid electricity',
      },
      journalEntries: [
        { account: 'Utilities Expense', entryType: 'debit', amount: 1000 },
        { account: 'Cash', entryType: 'credit', amount: 1000 },
      ],
      confidence: { overall: 0.9 },
      requiresReview: false,
      reviewReasons: [],
    });
    const req = reqWithUser({ text: 'Paid electricity bill of 5000' });
    const res = mockRes();

    await transactionController.processNaturalLanguage(req, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  // ── Phase 3: opt-in zero-click auto-post ─────────────────────────────────────
  describe('opt-in auto-post (>=98% confidence, exact account match, business opted in)', () => {
    const ACCOUNTS = [
      { _id: 'acc-util', accountName: 'Utilities Expense' },
      { _id: 'acc-cash', accountName: 'Cash' },
    ];
    const HIGH_CONF_PARSE = {
      success: true,
      parsedData: { amount: 1000, date: '2025-01-15', transactionType: 'Expense', description: 'Electricity bill', intent: 'Paid electricity' },
      journalEntries: [
        { account: 'Utilities Expense', entryType: 'debit', amount: 1000 },
        { account: 'Cash', entryType: 'credit', amount: 1000 },
      ],
      confidence: { overall: 0.99 },
      requiresReview: false,
      reviewReasons: [],
      accountResolution: {
        debit:  { matchType: 'exact', confidence: 1.0 },
        credit: { matchType: 'exact', confidence: 1.0 },
      },
    };

    beforeEach(() => {
      transactionService.__esModule = true;
      require('../../../repositories/account.repository').findByBusiness.mockResolvedValue(ACCOUNTS);
      transactionService.createTransaction.mockResolvedValue({ _id: 'tx-auto' });
    });

    test('auto-posts with zero clicks when opted in + exact match + >=98% confidence', async () => {
      businessRepository.findById.mockResolvedValue({ aiSettings: { autoPostEnabled: true } });
      parserService.parseTransaction.mockResolvedValue(HIGH_CONF_PARSE);
      const req = reqWithUser({ text: 'Paid electricity bill of 1000 from cash' });
      const res = mockRes();

      await transactionController.processNaturalLanguage(req, res, mockNext);

      expect(approvalService.submitOrPost).toHaveBeenCalledWith(
        expect.objectContaining({ transactionSource: 'ai_auto_posted' }),
        req.user, req.ip, expect.any(Object)
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    test('does NOT auto-post when the business has not opted in (default false)', async () => {
      businessRepository.findById.mockResolvedValue({ aiSettings: { autoPostEnabled: false } });
      parserService.parseTransaction.mockResolvedValue(HIGH_CONF_PARSE);
      const req = reqWithUser({ text: 'Paid electricity bill of 1000 from cash' });
      const res = mockRes();

      await transactionController.processNaturalLanguage(req, res, mockNext);

      expect(approvalService.submitOrPost).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200); // plain preview, unchanged
    });

    test('does NOT auto-post when the account match is fuzzy, even at 100% overall confidence', async () => {
      businessRepository.findById.mockResolvedValue({ aiSettings: { autoPostEnabled: true } });
      parserService.parseTransaction.mockResolvedValue({
        ...HIGH_CONF_PARSE,
        confidence: { overall: 1.0 },
        accountResolution: { debit: { matchType: 'fuzzy', confidence: 0.75 }, credit: { matchType: 'exact', confidence: 1.0 } },
      });
      const req = reqWithUser({ text: 'Paid electricity bill of 1000 from cash' });
      const res = mockRes();

      await transactionController.processNaturalLanguage(req, res, mockNext);

      expect(approvalService.submitOrPost).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('does NOT auto-post when confidence is in the 95-98% band', async () => {
      businessRepository.findById.mockResolvedValue({ aiSettings: { autoPostEnabled: true } });
      parserService.parseTransaction.mockResolvedValue({ ...HIGH_CONF_PARSE, confidence: { overall: 0.96 } });
      const req = reqWithUser({ text: 'Paid electricity bill of 1000 from cash' });
      const res = mockRes();

      await transactionController.processNaturalLanguage(req, res, mockNext);

      expect(approvalService.submitOrPost).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('falls back to the plain preview when the amount still exceeds the approval threshold', async () => {
      businessRepository.findById.mockResolvedValue({ aiSettings: { autoPostEnabled: true } });
      parserService.parseTransaction.mockResolvedValue(HIGH_CONF_PARSE);
      approvalService.submitOrPost.mockResolvedValueOnce({ pendingApproval: true, pendingTransaction: { _id: 'pend1' }, threshold: 500 });
      const req = reqWithUser({ text: 'Paid electricity bill of 1000 from cash' });
      const res = mockRes();

      await transactionController.processNaturalLanguage(req, res, mockNext);

      expect(approvalService.submitOrPost).toHaveBeenCalled();
      // Even though the confidence gate passed, the amount gate parked it — the
      // response must not claim the transaction auto-posted.
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});

// ── confirmExcelImport — per-row confidence enforcement (Phase 4) ──────────────
describe('transactionController.confirmExcelImport()', () => {
  const ACCOUNTS = [
    { _id: 'acc-rent', accountName: 'Rent' },
    { _id: 'acc-cash', accountName: 'Cash' },
  ];
  const row = (originalRow, confidenceLabel, overrides = {}) => ({
    originalRow, confidenceLabel,
    transactionDate: '2026-06-01', description: 'Test row', amount: 100,
    debitAccountName: 'Rent', creditAccountName: 'Cash',
    ...overrides,
  });

  beforeEach(() => {
    accountRepository.findByBusiness.mockResolvedValue(ACCOUNTS);
    batchPostingService.postBatch.mockResolvedValue({ posted: 0, pending: 0, failed: [], batchId: 'batch1' });
  });

  test('High-confidence rows import normally (unchanged behavior)', async () => {
    const req = reqWithUser({ rows: [row(2, 'High')] });
    const res = mockRes();
    await transactionController.confirmExcelImport(req, res, mockNext);
    expect(batchPostingService.postBatch).toHaveBeenCalledWith(
      'biz001',
      expect.arrayContaining([expect.objectContaining({ debitAccountId: 'acc-rent', creditAccountId: 'acc-cash' })]),
      req.user, req.ip, expect.any(Object)
    );
  });

  test('Medium-confidence rows still import but are tagged needsSpotCheck and counted as flagged', async () => {
    batchPostingService.postBatch.mockResolvedValue({ posted: 1, pending: 0, failed: [], batchId: 'batch1' });
    const req = reqWithUser({ rows: [row(3, 'Medium')] });
    const res = mockRes();
    await transactionController.confirmExcelImport(req, res, mockNext);

    expect(batchPostingService.postBatch).toHaveBeenCalledWith(
      'biz001',
      expect.arrayContaining([expect.objectContaining({ metadata: expect.objectContaining({ needsSpotCheck: true }) })]),
      req.user, req.ip, expect.any(Object)
    );
    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.data.flagged).toBe(1);
  });

  test('Low-confidence rows are NOT imported — held back with a clear reason', async () => {
    const req = reqWithUser({ rows: [row(4, 'Low')] });
    const res = mockRes();
    await transactionController.confirmExcelImport(req, res, mockNext);

    // Never even attempted to post the low-confidence row.
    expect(batchPostingService.postBatch).toHaveBeenCalledWith('biz001', [], req.user, req.ip, expect.any(Object));
    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.data.failed).toEqual(
      expect.arrayContaining([expect.objectContaining({ row: 4, error: expect.stringMatching(/confidence/i) })])
    );
  });

  test('a mix of High/Medium/Low rows partitions correctly in one request', async () => {
    batchPostingService.postBatch.mockResolvedValue({ posted: 2, pending: 0, failed: [], batchId: 'batch1' });
    const req = reqWithUser({ rows: [row(1, 'High'), row(2, 'Medium'), row(3, 'Low')] });
    const res = mockRes();
    await transactionController.confirmExcelImport(req, res, mockNext);

    const postedRows = batchPostingService.postBatch.mock.calls[0][1];
    expect(postedRows).toHaveLength(2); // High + Medium only
    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.data.flagged).toBe(1);
    expect(jsonArg.data.failed).toHaveLength(1);
  });
});

// ── getTransactions ───────────────────────────────────────────────────────────
describe('transactionController.getTransactions()', () => {
  test('should call getTransactionHistory with correct pagination defaults', async () => {
    transactionService.getTransactionHistory.mockResolvedValue({ data: [], total: 0 });
    const req = reqWithUser({}, {}); // no pagination query params
    const res = mockRes();

    await transactionController.getTransactions(req, res, mockNext);
    expect(transactionService.getTransactionHistory).toHaveBeenCalledWith(
      'biz001',
      expect.any(Object),
      expect.objectContaining({ page: 1, limit: 25 })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('should parse page and limit from query string', async () => {
    transactionService.getTransactionHistory.mockResolvedValue({ data: [], total: 0 });
    const req = reqWithUser({}, { page: '2', limit: '10' });
    const res = mockRes();

    await transactionController.getTransactions(req, res, mockNext);
    expect(transactionService.getTransactionHistory).toHaveBeenCalledWith(
      'biz001',
      expect.any(Object),
      expect.objectContaining({ page: 2, limit: 10 })
    );
  });
});

// ── getTransactionById ────────────────────────────────────────────────────────
describe('transactionController.getTransactionById()', () => {
  test('should return transaction on success', async () => {
    transactionService.getTransactionById.mockResolvedValue({ _id: 'tx1' });
    const req = reqWithUser({}, {}, { id: 'tx1' });
    const res = mockRes();

    await transactionController.getTransactionById(req, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('should call next(error) when not found', async () => {
    transactionService.getTransactionById.mockRejectedValue(new ApiError(404, 'Not found'));
    const req = reqWithUser({}, {}, { id: 'bad-id' });
    const res = mockRes();

    await transactionController.getTransactionById(req, res, mockNext);
    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });
});

// ── deleteTransaction ─────────────────────────────────────────────────────────
describe('transactionController.deleteTransaction()', () => {
  test('should return reversal on success', async () => {
    transactionService.deleteTransaction.mockResolvedValue({ _id: 'tx_rev' });
    const req = reqWithUser({}, {}, { id: 'tx1' });
    const res = mockRes();

    await transactionController.deleteTransaction(req, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

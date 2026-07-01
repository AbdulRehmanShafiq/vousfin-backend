// tests/unit/controllers/transaction.controller.test.js
jest.mock('../../../services/transaction.service');
jest.mock('../../../services/nlParser/services/parserService');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../repositories/business.repository', () => ({
  findById: jest.fn().mockResolvedValue({ aiSettings: { autoPostEnabled: false } }),
}));
jest.mock('../../../utils/excelParser.utils');
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

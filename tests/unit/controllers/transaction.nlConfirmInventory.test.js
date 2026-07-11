// tests/unit/controllers/transaction.nlConfirmInventory.test.js
//
// Smart entry — the NL confirm endpoint must forward inventory linkage
// (existing item or consented new item) into createTransaction, and resolve
// unknown account NAMES through the deterministic import chain instead of
// failing with a 400.
'use strict';
jest.mock('../../../services/transaction.service');
jest.mock('../../../services/nlParser/services/parserService');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../repositories/business.repository', () => ({
  findById: jest.fn().mockResolvedValue({ aiSettings: { autoPostEnabled: false } }),
}));
jest.mock('../../../models/InventoryItem.model', () => ({
  find: jest.fn().mockReturnValue({
    select: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue([]),
  }),
}));
jest.mock('../../../utils/excelParser.utils');
jest.mock('../../../services/batchPosting.service', () => ({
  postBatch: jest.fn().mockResolvedValue({ posted: 0, pending: 0, failed: [], batchId: 'batch1' }),
}));
jest.mock('../../../services/approval.service', () => ({
  submitOrPost: jest.fn().mockResolvedValue({ pendingApproval: false, transaction: { _id: 'tx1' } }),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../../services/aiDecision.service', () => ({
  record: jest.fn().mockResolvedValue({ _id: 'dec1' }),
  recordOutcome: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../services/learnedResolution.service', () => ({
  recallAccounts: jest.fn().mockResolvedValue(null),
  learnAccountsFromConfirmation: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../services/importAccountResolution.service', () => ({
  resolveForImport: jest.fn(),
}));

const transactionController = require('../../../controllers/transaction.controller');
const { resolveForImport } = require('../../../services/importAccountResolution.service');
const accountRepository = require('../../../repositories/account.repository');
const approvalService = require('../../../services/approval.service');

const mkRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};
const mkReq = (body) => ({ body, user: { businessId: 'biz1', id: 'u1' }, ip: '127.0.0.1' });

beforeEach(() => {
  jest.clearAllMocks();
  accountRepository.findByBusiness.mockResolvedValue([]);
  approvalService.submitOrPost.mockResolvedValue({ pendingApproval: false, transaction: { _id: 'tx1' } });
});

describe('confirmNaturalLanguage — smart entry', () => {
  const BASE = {
    transactionDate: '2026-07-10', description: 'Stock purchase', transactionType: 'Inventory Purchase',
    amount: 5000, debitAccountId: 'a-inv', creditAccountId: 'a-cash',
  };

  test('forwards existing-item linkage into transactionData', async () => {
    await transactionController.confirmNaturalLanguage(mkReq({ ...BASE, inventoryItemId: 'i1', inventoryQty: 10 }), mkRes(), jest.fn());
    const txData = approvalService.submitOrPost.mock.calls[0][0];
    expect(txData.inventoryItemId).toBe('i1');
    expect(txData.inventoryQty).toBe(10);
  });

  test('forwards a consented newInventoryItem (sanitized)', async () => {
    await transactionController.confirmNaturalLanguage(mkReq({
      ...BASE,
      newInventoryItem: { name: '  Flour ', unit: 'bags', quantity: '20', unitCostPrice: 250 },
    }), mkRes(), jest.fn());
    const txData = approvalService.submitOrPost.mock.calls[0][0];
    expect(txData.newInventoryItem).toEqual({ name: 'Flour', unit: 'bags', quantity: 20, unitCostPrice: 250 });
  });

  test('unknown account NAME resolves through the deterministic chain instead of 400', async () => {
    resolveForImport.mockResolvedValue({ account: { _id: 'created-1', accountName: 'Inventory' }, created: true, how: 'created' });
    await transactionController.confirmNaturalLanguage(mkReq({
      ...BASE, debitAccountId: undefined, debitAccount: 'Inventory',
    }), mkRes(), jest.fn());
    expect(resolveForImport).toHaveBeenCalledWith('biz1', expect.any(Array), 'Inventory',
      expect.objectContaining({ side: 'debit', transactionType: 'Inventory Purchase', userId: 'u1' }));
    const txData = approvalService.submitOrPost.mock.calls[0][0];
    expect(txData.debitAccountId).toBe('created-1');
  });
});

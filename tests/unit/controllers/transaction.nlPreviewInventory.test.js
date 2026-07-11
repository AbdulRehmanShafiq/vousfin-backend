// tests/unit/controllers/transaction.nlPreviewInventory.test.js
//
// Smart entry — the NL preview endpoint must (a) hand live inventory items to
// the parser, (b) surface the parser's inventory block, (c) hard-block
// auto-post on pending item creation or a guardrail violation, and (d) carry
// inventoryItemId/inventoryQty on an auto-posted matched item so stock syncs.
'use strict';
jest.mock('../../../services/transaction.service');
jest.mock('../../../services/nlParser/services/parserService');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../repositories/business.repository', () => ({
  findById: jest.fn(),
}));
jest.mock('../../../models/InventoryItem.model', () => ({ find: jest.fn() }));
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
const parserService = require('../../../services/nlParser/services/parserService');
const accountRepository = require('../../../repositories/account.repository');
const businessRepository = require('../../../repositories/business.repository');
const InventoryItem = require('../../../models/InventoryItem.model');
const approvalService = require('../../../services/approval.service');

const ACCOUNTS = [
  { _id: 'a-inv',  accountName: 'Inventory',      accountType: 'Asset' },
  { _id: 'a-cash', accountName: 'Cash in Hand',   accountType: 'Asset' },
  { _id: 'a-rev',  accountName: 'Sales Revenue',  accountType: 'Revenue' },
];

const mkRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};
const mkReq = (body) => ({ body, user: { businessId: 'biz1', id: 'u1' }, ip: '127.0.0.1' });

const parsedResult = (over = {}) => ({
  success: true,
  parsedData: {
    transactionType: 'inventory_purchase', amount: 5000, isInstallment: false,
    inventory: { mode: 'existing', itemId: 'i1', itemName: 'Rice (bag)', quantity: 10, unit: 'bags', unitCostPrice: 500, currentStock: 12 },
    lineItems: [{ name: 'rice', quantity: 10, unit: 'bags', unitPrice: 500 }],
    ...(over.parsedData || {}),
  },
  journalEntries: over.journalEntries || [
    { entryType: 'debit', account: 'Inventory', amount: 5000 },
    { entryType: 'credit', account: 'Cash in Hand', amount: 5000 },
  ],
  confidence: { overall: 0.99, intent: 0.99, amount: 0.99, date: 0.99, accountMapping: 0.99 },
  accountResolution: {
    debit: { account: ACCOUNTS[0], confidence: 1, matchType: 'exact' },
    credit: { account: ACCOUNTS[1], confidence: 1, matchType: 'exact' },
  },
  requiresReview: false, reviewReasons: [], clarification: null, needsClarification: false,
});

beforeEach(() => {
  jest.clearAllMocks();
  accountRepository.findByBusiness.mockResolvedValue(ACCOUNTS);
  InventoryItem.find.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue([{ _id: 'i1', name: 'Rice (bag)', unit: 'bags', unitCostPrice: 480, currentStock: 12 }]),
  });
  businessRepository.findById.mockResolvedValue({ aiSettings: { autoPostEnabled: true } });
  approvalService.submitOrPost.mockResolvedValue({ pendingApproval: false, transaction: { _id: 'tx1' } });
});

describe('processNaturalLanguage — inventory context + gates', () => {
  test('passes live inventory items into the parser', async () => {
    parserService.parseTransaction.mockResolvedValue(parsedResult());
    await transactionController.processNaturalLanguage(mkReq({ text: 'bought 10 bags of rice for 5000 cash' }), mkRes(), jest.fn());
    const opts = parserService.parseTransaction.mock.calls[0][2];
    expect(opts.inventoryItems).toHaveLength(1);
    expect(opts.inventoryItems[0].name).toBe('Rice (bag)');
  });

  test('preview carries the inventory block through', async () => {
    parserService.parseTransaction.mockResolvedValue(parsedResult());
    businessRepository.findById.mockResolvedValue({ aiSettings: { autoPostEnabled: false } });
    const res = mkRes();
    await transactionController.processNaturalLanguage(mkReq({ text: 'bought 10 bags of rice for 5000 cash' }), res, jest.fn());
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.inventory).toMatchObject({ mode: 'existing', itemId: 'i1', quantity: 10 });
  });

  test('auto-post of a matched item CARRIES inventoryItemId + inventoryQty', async () => {
    parserService.parseTransaction.mockResolvedValue(parsedResult());
    await transactionController.processNaturalLanguage(mkReq({ text: 'bought 10 bags of rice for 5000 cash' }), mkRes(), jest.fn());
    expect(approvalService.submitOrPost).toHaveBeenCalledTimes(1);
    const txData = approvalService.submitOrPost.mock.calls[0][0];
    expect(txData.inventoryItemId).toBe('i1');
    expect(txData.inventoryQty).toBe(10);
  });

  test('pending item creation hard-blocks auto-post', async () => {
    parserService.parseTransaction.mockResolvedValue(parsedResult({
      parsedData: { inventory: { mode: 'create', itemName: 'flour', quantity: 20, unit: 'bags', unitCostPrice: 250 } },
    }));
    await transactionController.processNaturalLanguage(mkReq({ text: 'bought flour stock 5000' }), mkRes(), jest.fn());
    expect(approvalService.submitOrPost).not.toHaveBeenCalled();
  });

  test('missing quantity on a matched item blocks auto-post', async () => {
    parserService.parseTransaction.mockResolvedValue(parsedResult({
      parsedData: { inventory: { mode: 'existing', itemId: 'i1', itemName: 'Rice (bag)', quantity: null, unit: 'bags', unitCostPrice: null, currentStock: 12 } },
    }));
    await transactionController.processNaturalLanguage(mkReq({ text: 'bought rice for 5000 cash' }), mkRes(), jest.fn());
    expect(approvalService.submitOrPost).not.toHaveBeenCalled();
  });

  test('guardrail violation blocks auto-post and forces review', async () => {
    // AI suggested crediting Sales Revenue on a purchase — structurally wrong
    parserService.parseTransaction.mockResolvedValue(parsedResult({
      journalEntries: [
        { entryType: 'debit', account: 'Inventory', amount: 5000 },
        { entryType: 'credit', account: 'Sales Revenue', amount: 5000 },
      ],
      parsedData: { inventory: { mode: 'none' } },
    }));
    const res = mkRes();
    await transactionController.processNaturalLanguage(mkReq({ text: 'bought rice, weird parse' }), res, jest.fn());
    expect(approvalService.submitOrPost).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.requiresReview).toBe(true);
    expect(payload.data.guardrail.ok).toBe(false);
  });
});

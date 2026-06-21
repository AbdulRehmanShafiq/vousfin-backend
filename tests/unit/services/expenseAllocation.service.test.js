/**
 * tests/unit/services/expenseAllocation.service.test.js
 *
 * Phase 3.3 — Unit tests for ExpenseAllocationService.
 * Tests _buildLines, balance validation, and allocation creation.
 * DB interactions are mocked.
 */
'use strict';

const ID_BUSINESS = '507f1f77bcf86cd799439040';
const ID_BILL     = '507f1f77bcf86cd799439041';
const ID_ALLOC    = '507f1f77bcf86cd799439042';

jest.mock('../../../models/Bill.model',           () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn(), find: jest.fn() }));
jest.mock('../../../models/BillAllocation.model', () => ({
  create:       jest.fn(),
  findOne:      jest.fn(),
  findOneAndDelete: jest.fn(),
  aggregate:    jest.fn(),
}));
jest.mock('../../../models/ChartOfAccount.model', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/JournalEntry.model',   () => ({ create:  jest.fn() }));

const Bill            = require('../../../models/Bill.model');
const BillAllocation  = require('../../../models/BillAllocation.model');
const ChartOfAccount  = require('../../../models/ChartOfAccount.model');
const JournalEntry    = require('../../../models/JournalEntry.model');
const svc             = require('../../../services/expenseAllocation.service');
const { ALLOCATION_METHODS } = require('../../../config/constants');

afterEach(() => jest.resetAllMocks());

// ── _buildLines ───────────────────────────────────────────────────────────────

describe('_buildLines()', () => {
  const lines = [
    { costCenterType: 'department', costCenterId: 'D1', costCenterName: 'Engineering', percentage: '60' },
    { costCenterType: 'department', costCenterId: 'D2', costCenterName: 'Marketing',   percentage: '40' },
  ];

  it('equal: splits totalAmount evenly', () => {
    const result = svc._buildLines([
      { costCenterType: 'department', costCenterId: 'D1', costCenterName: 'Eng' },
      { costCenterType: 'department', costCenterId: 'D2', costCenterName: 'Mkt' },
    ], 1000, ALLOCATION_METHODS.EQUAL);
    expect(result[0].amount).toBe(500);
    expect(result[1].amount).toBe(500);
  });

  it('equal: last line absorbs rounding difference', () => {
    const result = svc._buildLines([
      { costCenterType: 'department', costCenterId: 'D1', costCenterName: 'Eng' },
      { costCenterType: 'department', costCenterId: 'D2', costCenterName: 'Mkt' },
      { costCenterType: 'department', costCenterId: 'D3', costCenterName: 'HR' },
    ], 100, ALLOCATION_METHODS.EQUAL);
    const sum = result.reduce((s, l) => s + l.amount, 0);
    expect(Math.abs(sum - 100)).toBeLessThan(0.01);
  });

  it('percentage: computes amounts from percentages', () => {
    const result = svc._buildLines(lines, 1000, ALLOCATION_METHODS.PERCENTAGE);
    expect(result[0].amount).toBe(600);
    expect(result[1].amount).toBe(400);
  });

  it('amount: keeps amounts as-is and computes percentages', () => {
    const amtLines = [
      { costCenterType: 'department', costCenterId: 'D1', costCenterName: 'Eng', amount: '700' },
      { costCenterType: 'department', costCenterId: 'D2', costCenterName: 'Mkt', amount: '300' },
    ];
    const result = svc._buildLines(amtLines, 1000, ALLOCATION_METHODS.AMOUNT);
    expect(result[0].percentage).toBe(70);
    expect(result[1].percentage).toBe(30);
  });
});

// ── _validateLines ────────────────────────────────────────────────────────────

describe('_validateLines()', () => {
  it('throws 400 when lines array is empty', () => {
    expect(() => svc._validateLines([], 1000, 'percentage'))
      .toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('throws 400 when percentages do not sum to 100', () => {
    const lines = [
      { costCenterType: 'department', costCenterId: 'D1', costCenterName: 'X', percentage: 50 },
    ];
    expect(() => svc._validateLines(lines, 1000, ALLOCATION_METHODS.PERCENTAGE))
      .toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('throws 400 when amounts do not equal total', () => {
    const lines = [
      { costCenterType: 'department', costCenterId: 'D1', costCenterName: 'X', amount: 400 },
    ];
    expect(() => svc._validateLines(lines, 1000, ALLOCATION_METHODS.AMOUNT))
      .toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('passes when percentages sum to 100', () => {
    const lines = [
      { costCenterType: 'department', costCenterId: 'D1', costCenterName: 'X', percentage: 60 },
      { costCenterType: 'department', costCenterId: 'D2', costCenterName: 'Y', percentage: 40 },
    ];
    expect(() => svc._validateLines(lines, 1000, ALLOCATION_METHODS.PERCENTAGE)).not.toThrow();
  });
});

// ── getAgingReport ────────────────────────────────────────────────────────────

describe('getAgingReport()', () => {
  it('returns bucket structure with correct total', async () => {
    const today = new Date();
    const past5  = new Date(today); past5.setDate(past5.getDate() - 5);
    const past35 = new Date(today); past35.setDate(past35.getDate() - 35);

    const mockBills = [
      { dueDate: past5,  remainingBalance: 200, vendorId: null, vendorSnapshot: {} },
      { dueDate: past35, remainingBalance: 300, vendorId: null, vendorSnapshot: {} },
    ];

    const leanFn   = jest.fn().mockResolvedValueOnce(mockBills);
    const selectFn = jest.fn().mockReturnValueOnce({ lean: leanFn });
    Bill.find.mockReturnValueOnce({ select: selectFn });

    const result = await svc.getAgingReport(ID_BUSINESS);
    expect(result.buckets['1_30']).toBe(200);
    expect(result.buckets['31_60']).toBe(300);
    expect(result.billCount).toBe(2);
  });
});

// ── create (integration mock) ─────────────────────────────────────────────────

describe('create()', () => {
  it('creates a balanced allocation for a bill', async () => {
    const bill = {
      _id: ID_BILL,
      billNumber: 'BILL-001',
      totalAmount: 1000,
      currencyCode: 'PKR',
      allocationId: null,
      save: jest.fn().mockResolvedValue(true),
    };
    const allocDoc = { _id: ID_ALLOC };

    Bill.findOne.mockResolvedValueOnce(bill);
    BillAllocation.findOne.mockResolvedValueOnce(null);  // no existing
    BillAllocation.create.mockResolvedValueOnce(allocDoc);

    const result = await svc.create(ID_BILL, ID_BUSINESS, {
      method: ALLOCATION_METHODS.EQUAL,
      lines: [
        { costCenterType: 'department', costCenterId: 'D1', costCenterName: 'Engineering' },
        { costCenterType: 'department', costCenterId: 'D2', costCenterName: 'Marketing'  },
      ],
    }, { _id: '507f1f77bcf86cd799439099' });

    expect(BillAllocation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        billId:    ID_BILL,
        isBalanced: true,
        method:    ALLOCATION_METHODS.EQUAL,
      })
    );
    expect(bill.allocationId).toBe(ID_ALLOC);
    expect(bill.save).toHaveBeenCalled();
    expect(result).toBe(allocDoc);
  });

  it('throws 404 when bill not found', async () => {
    Bill.findOne.mockResolvedValueOnce(null);
    await expect(svc.create(ID_BILL, ID_BUSINESS, { method: 'equal', lines: [] }, {}))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('does NOT post a duplicate AP journal — the bill already books DR Expense / CR AP on approval', async () => {
    // Regression for audit finding A1: the bill's postApLiabilityJournal is the
    // single source of the expense + AP posting. An allocation that ALSO posted
    // DR Expense / CR AP would double-count the expense and the liability. The
    // allocation must only persist the cost-centre split.
    const bill = {
      _id: ID_BILL, billNumber: 'BILL-002', totalAmount: 1000,
      currencyCode: 'PKR', allocationId: null, save: jest.fn().mockResolvedValue(true),
    };
    Bill.findOne.mockResolvedValueOnce(bill);
    // AP account EXISTS — exercises the path the old broken code used to post on.
    ChartOfAccount.findOne.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue({ _id: 'ap-2110' }) });
    BillAllocation.findOne.mockResolvedValueOnce(null);
    BillAllocation.create.mockResolvedValueOnce({ _id: ID_ALLOC });

    await svc.create(ID_BILL, ID_BUSINESS, {
      method: ALLOCATION_METHODS.EQUAL,
      lines: [
        { costCenterType: 'department', costCenterId: 'D1', costCenterName: 'Eng' },
        { costCenterType: 'department', costCenterId: 'D2', costCenterName: 'Mkt' },
      ],
    }, { _id: '507f1f77bcf86cd799439099' });

    expect(JournalEntry.create).not.toHaveBeenCalled();
    expect(BillAllocation.create).toHaveBeenCalledWith(
      expect.objectContaining({ billId: ID_BILL, isBalanced: true })
    );
  });
});

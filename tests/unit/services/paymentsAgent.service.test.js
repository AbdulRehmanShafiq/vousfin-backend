'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../services/actionRouter.service', () => ({ propose: jest.fn() }));
jest.mock('../../../services/entityMemory.service', () => ({ learn: jest.fn(), suggest: jest.fn() }));
jest.mock('../../../services/payment.service', () => ({ recordPayment: jest.fn() }));
jest.mock('../../../repositories/account.repository', () => ({ findByBusiness: jest.fn() }));
jest.mock('../../../models/Bill.model', () => ({ find: jest.fn() }));
jest.mock('../../../repositories/proposedAction.repository', () => ({ latestBySource: jest.fn() }));

const actionRouter = require('../../../services/actionRouter.service');
const entityMemory = require('../../../services/entityMemory.service');
const paymentService = require('../../../services/payment.service');
const accountRepo = require('../../../repositories/account.repository');
const Bill = require('../../../models/Bill.model');
const repo = require('../../../repositories/proposedAction.repository');
const agent = require('../../../services/paymentsAgent.service');

const BIZ = 'biz1';
const NOW = new Date('2026-06-17T00:00:00Z');
const CASH = [
  { _id: 'acc_bank', accountName: 'Cash at Bank', accountSubtype: 'Bank and Cash', runningBalance: 100000 },
  { _id: 'acc_petty', accountName: 'Petty Cash', accountSubtype: 'Bank and Cash', runningBalance: 2000 },
  { _id: 'acc_rev', accountName: 'Sales', accountSubtype: 'Income', runningBalance: 999999 },
];
function mockBills(arr) { Bill.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(arr) }) }); }

beforeEach(() => {
  jest.clearAllMocks();
  accountRepo.findByBusiness.mockResolvedValue(CASH);
  entityMemory.suggest.mockResolvedValue(null);
  repo.latestBySource.mockResolvedValue(null);
  actionRouter.propose.mockResolvedValue({ _id: 'a1', status: 'queued' });
});

describe('cashContext', () => {
  it('sums only Bank-and-Cash balances and draws from the fullest account', async () => {
    const c = await agent.cashContext(BIZ);
    expect(c.available).toBe(102000);
    expect(c.primaryId).toBe('acc_bank');
  });
});

describe('classifyBill', () => {
  it('prioritises a live early-payment discount and computes the saving', () => {
    const c = agent.classifyBill({ remainingBalance: 10000, paymentTerms: { discountPct: 2, discountDeadline: '2026-06-25', discountTakenAt: null } }, NOW);
    expect(c.reason).toBe('discount'); expect(c.priority).toBe(0); expect(c.saving).toBe(200);
  });
  it('flags an overdue bill', () => {
    const c = agent.classifyBill({ remainingBalance: 5000, dueDate: '2026-06-01', state: 'overdue' }, NOW);
    expect(c.reason).toBe('overdue'); expect(c.priority).toBe(1);
  });
  it('flags a bill due within the week', () => {
    const c = agent.classifyBill({ remainingBalance: 5000, dueDate: '2026-06-20' }, NOW);
    expect(c.reason).toBe('due_soon');
  });
  it('skips a bill that is not urgent', () => {
    expect(agent.classifyBill({ remainingBalance: 5000, dueDate: '2026-08-01' }, NOW)).toBeNull();
  });
});

describe('scanBusiness', () => {
  const overdue = { _id: 'b1', billNumber: 'BILL-1', vendorId: 'v1', vendorSnapshot: { vendorName: 'ABC Co' }, dueDate: '2026-06-01', remainingBalance: 5000, state: 'overdue', paymentTerms: {} };

  it('proposes a make_payment for an urgent bill within cash on hand', async () => {
    mockBills([overdue]);
    const n = await agent.scanBusiness(BIZ, { id: 'u1' }, NOW);
    expect(n).toBe(1);
    expect(actionRouter.propose).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'payments', type: 'make_payment', amount: 5000,
      payload: expect.objectContaining({ billId: 'b1', cashAccountId: 'acc_bank' }),
      sourceType: 'bill_payment', sourceId: 'b1',
    }));
  });

  it('excludes vendors on hold', async () => {
    mockBills([overdue]);
    entityMemory.suggest.mockResolvedValue({ value: { hold: true } });
    expect(await agent.scanBusiness(BIZ, {}, NOW)).toBe(0);
    expect(actionRouter.propose).not.toHaveBeenCalled();
  });

  it('defers a bill that would exceed cash on hand (runway guardrail)', async () => {
    accountRepo.findByBusiness.mockResolvedValue([{ _id: 'acc_bank', accountName: 'Cash at Bank', accountSubtype: 'Bank and Cash', runningBalance: 1000 }]);
    mockBills([overdue]); // 5000 > 1000 available
    expect(await agent.scanBusiness(BIZ, {}, NOW)).toBe(0);
  });

  it('proposes nothing when there is no cash/bank account', async () => {
    accountRepo.findByBusiness.mockResolvedValue([{ _id: 'x', accountName: 'Sales', accountSubtype: 'Income', runningBalance: 1 }]);
    mockBills([overdue]);
    expect(await agent.scanBusiness(BIZ, {}, NOW)).toBe(0);
  });

  it('skips a bill already proposed/handled', async () => {
    mockBills([overdue]);
    repo.latestBySource.mockResolvedValue({ status: 'queued' });
    expect(await agent.scanBusiness(BIZ, {}, NOW)).toBe(0);
  });
});

describe('executor', () => {
  it('records the payment against the bill on execute', async () => {
    paymentService.recordPayment.mockResolvedValue({ _id: 'pay1', paymentNumber: 'PAY-1' });
    const r = await agent.executeMakePayment({ businessId: BIZ, payload: { billId: 'b1', amount: 5000, cashAccountId: 'acc_bank', userId: 'u1' } });
    expect(paymentService.recordPayment).toHaveBeenCalledWith(BIZ, expect.objectContaining({
      amount: 5000, // top-level total is required by recordPayment (regression guard)
      cashAccountId: 'acc_bank', allocations: [{ documentType: 'bill', documentId: 'b1', amount: 5000 }],
    }), 'u1', null);
    expect(r).toEqual({ paymentId: 'pay1', paymentNumber: 'PAY-1' });
  });

  it('is not one-click reversible (a recorded payment is a real accounting event)', () => {
    const executors = require('../../../services/actionExecutors');
    expect(typeof executors.executor('make_payment')).toBe('function');
    expect(executors.reverser('make_payment')).toBeUndefined();
  });
});

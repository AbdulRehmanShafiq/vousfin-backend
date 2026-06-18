'use strict';
jest.mock('../../../repositories/payrollRun.repository', () => ({ findOwned: jest.fn() }));
jest.mock('../../../services/transaction.service', () => ({ createTransaction: jest.fn(), reverseTransaction: jest.fn() }));
jest.mock('../../../repositories/account.repository', () => ({ findByCode: jest.fn() }));

const runRepo = require('../../../repositories/payrollRun.repository');
const txService = require('../../../services/transaction.service');
const accountRepo = require('../../../repositories/account.repository');
const payroll = require('../../../services/payroll.service');

const BIZ = 'biz1';
function run(over = {}) {
  return {
    _id: 'run1', businessId: BIZ, period: '2026-06', status: 'posted',
    totals: { netPay: 139350 }, postedJournalEntryIds: ['je1', 'je2'], reversalJournalEntryIds: [],
    save: jest.fn().mockImplementation(function () { return Promise.resolve(this); }), ...over,
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  accountRepo.findByCode.mockResolvedValue({ _id: 'acc-2140' });
  txService.createTransaction.mockResolvedValue({ _id: 'jePay' });
  txService.reverseTransaction.mockResolvedValue({ _id: 'jeRev' });
});

describe('markPaid', () => {
  it('posts Dr Wages Payable / Cr bank for the net total and moves to paid', async () => {
    runRepo.findOwned.mockResolvedValue(run());
    const r = await payroll.markPaid(BIZ, 'run1', 'bankAcc1', { id: 'u1' });
    const p = txService.createTransaction.mock.calls[0][0];
    expect(p).toMatchObject({ amount: 139350, debitAccountId: 'acc-2140', creditAccountId: 'bankAcc1' });
    expect(r.status).toBe('paid');
  });
  it('refuses to pay a run that is not posted', async () => {
    runRepo.findOwned.mockResolvedValue(run({ status: 'processed' }));
    await expect(payroll.markPaid(BIZ, 'run1', 'bankAcc1', { id: 'u1' })).rejects.toThrow(/cannot be paid/i);
  });
});

describe('reverseRun', () => {
  it('reverses every posted entry and marks the run reversed', async () => {
    runRepo.findOwned.mockResolvedValue(run());
    const r = await payroll.reverseRun(BIZ, 'run1', { id: 'u1' });
    expect(txService.reverseTransaction).toHaveBeenCalledTimes(2);
    expect(r.status).toBe('reversed');
    expect(r.reversalJournalEntryIds).toEqual(['jeRev', 'jeRev']);
  });
  it('refuses to reverse a draft/processed run', async () => {
    runRepo.findOwned.mockResolvedValue(run({ status: 'processed' }));
    await expect(payroll.reverseRun(BIZ, 'run1', { id: 'u1' })).rejects.toThrow(/cannot be reversed/i);
  });
});

'use strict';
jest.mock('../../../repositories/payrollRun.repository', () => ({ findOwned: jest.fn() }));
jest.mock('../../../services/transaction.service', () => ({ createTransaction: jest.fn() }));
jest.mock('../../../repositories/account.repository', () => ({ findByCode: jest.fn() }));

const runRepo = require('../../../repositories/payrollRun.repository');
const txService = require('../../../services/transaction.service');
const accountRepo = require('../../../repositories/account.repository');
const payroll = require('../../../services/payroll.service');

const BIZ = 'biz1';
// account code → fake id
const ACCT = (code) => ({ _id: `acc-${code}`, accountCode: code });

function makeRun() {
  const line = {
    employeeId: 'e1', costCenterId: 'cc1', gross: 150000, incomeTax: 4900,
    eobiEmployee: 250, eobiEmployer: 1500, pfEmployee: 5000, pfEmployer: 5000,
    otherDeductionsTotal: 500, netPay: 139350,
  };
  return {
    _id: 'run1', businessId: BIZ, period: '2026-06', status: 'processed',
    lines: [line],
    totals: { gross: 150000, incomeTax: 4900, eobiEmployee: 250, eobiEmployer: 1500, pfEmployee: 5000, pfEmployer: 5000, otherDeductions: 500, netPay: 139350 },
    postedJournalEntryIds: [],
    save: jest.fn().mockImplementation(function () { return Promise.resolve(this); }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  accountRepo.findByCode.mockImplementation((biz, code) => Promise.resolve(ACCT(code)));
  let n = 0;
  txService.createTransaction.mockImplementation(() => Promise.resolve({ _id: `je${++n}` }));
});

describe('postToGL', () => {
  it('posts balanced Dr/Cr pairs whose debits equal gross + employer cost', async () => {
    const run = makeRun();
    runRepo.findOwned.mockResolvedValue(run);
    const posted = await payroll.postToGL(BIZ, 'run1', { id: 'u1' });

    const calls = txService.createTransaction.mock.calls.map((c) => c[0]);
    // every pair is independently balanced (distinct debit/credit, positive amount)
    for (const p of calls) {
      expect(p.amount).toBeGreaterThan(0);
      expect(p.debitAccountId).not.toBe(p.creditAccountId);
      expect(p.costCenterId).toBe('cc1');
      expect(p.idempotencyKey).toMatch(/^pr:run1:/);
      expect(p.skipTax).toBe(true);
    }
    // sum of debits to 6180 = gross; employer legs add eobiEmployer+pfEmployer
    const drTo6180 = calls.filter((p) => p.debitAccountId === 'acc-6180').reduce((s, p) => s + p.amount, 0);
    expect(drTo6180).toBe(150000);
    const totalDebits = calls.reduce((s, p) => s + p.amount, 0);
    expect(totalDebits).toBe(150000 + 1500 + 5000); // gross + employer EOBI + employer PF

    expect(posted.status).toBe('posted');
    expect(posted.postedJournalEntryIds).toHaveLength(calls.length);
  });

  it('refuses to post a run that is not in processed state', async () => {
    const run = { ...makeRun(), status: 'posted' };
    runRepo.findOwned.mockResolvedValue(run);
    await expect(payroll.postToGL(BIZ, 'run1', { id: 'u1' })).rejects.toThrow(/cannot be posted/i);
    expect(txService.createTransaction).not.toHaveBeenCalled();
  });
});

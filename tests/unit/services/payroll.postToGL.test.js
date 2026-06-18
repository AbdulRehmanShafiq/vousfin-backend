'use strict';
jest.mock('../../../repositories/payrollRun.repository', () => ({ findOwned: jest.fn() }));
jest.mock('../../../services/ledgerPosting.service', () => ({ postCompoundJournal: jest.fn() }));
jest.mock('../../../repositories/account.repository', () => ({ findByCode: jest.fn() }));

const runRepo = require('../../../repositories/payrollRun.repository');
const ledgerPosting = require('../../../services/ledgerPosting.service');
const accountRepo = require('../../../repositories/account.repository');
const payroll = require('../../../services/payroll.service');

const BIZ = 'biz1';
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
  ledgerPosting.postCompoundJournal.mockResolvedValue({ _id: 'je1' });
});

describe('postToGL', () => {
  it('posts ONE balanced compound entry, expense legs cost-centre tagged', async () => {
    const run = makeRun();
    runRepo.findOwned.mockResolvedValue(run);
    const posted = await payroll.postToGL(BIZ, 'run1', { id: 'u1' });

    expect(ledgerPosting.postCompoundJournal).toHaveBeenCalledTimes(1);
    const payload = ledgerPosting.postCompoundJournal.mock.calls[0][0];
    expect(payload.idempotencyKey).toBe('pr:run1:post');

    const lines = payload.lines;
    const debits = lines.filter(l => l.type === 'debit');
    const credits = lines.filter(l => l.type === 'credit');
    const sum = (ls) => ls.reduce((s, l) => s + l.amount, 0);
    // balanced
    expect(sum(debits)).toBe(sum(credits));
    // wages-expense debit equals gross; total debit = gross + employer EOBI + employer PF
    const wages = debits.filter(l => l.accountId === 'acc-6180').reduce((s, l) => s + l.amount, 0);
    expect(wages).toBe(150000);
    expect(sum(debits)).toBe(150000 + 1500 + 5000);
    // expense legs carry the cost-centre tag; payable credits don't need it
    expect(debits.every(l => l.costCenterId === 'cc1')).toBe(true);
    // net pay credited to wages payable
    expect(credits.find(l => l.accountId === 'acc-2140').amount).toBe(139350);

    expect(posted.status).toBe('posted');
    expect(posted.postedJournalEntryIds).toEqual(['je1']);
  });

  it('refuses to post a run that is not in processed state', async () => {
    const run = { ...makeRun(), status: 'posted' };
    runRepo.findOwned.mockResolvedValue(run);
    await expect(payroll.postToGL(BIZ, 'run1', { id: 'u1' })).rejects.toThrow(/cannot be posted/i);
    expect(ledgerPosting.postCompoundJournal).not.toHaveBeenCalled();
  });
});

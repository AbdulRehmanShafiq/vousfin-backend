'use strict';
jest.mock('../../../repositories/account.repository', () => ({ findByBusiness: jest.fn() }));
jest.mock('../../../repositories/transaction.repository', () => ({ getDebitCreditTotals: jest.fn() }));

const accountRepo = require('../../../repositories/account.repository');
const txRepo = require('../../../repositories/transaction.repository');
const integrity = require('../../../services/ledgerIntegrity.service');

const BIZ = 'biz1';

beforeEach(() => jest.clearAllMocks());

describe('computeDrift', () => {
  it('reports zero drift when cached balances match the journal', async () => {
    accountRepo.findByBusiness.mockResolvedValue([
      { _id: 'cash', accountCode: '1010', accountName: 'Cash', normalBalance: 'Debit', runningBalance: 1000 },
      { _id: 'sales', accountCode: '4110', accountName: 'Sales', normalBalance: 'Credit', runningBalance: 1000 },
    ]);
    txRepo.getDebitCreditTotals.mockResolvedValue({
      debitTotals: [{ _id: 'cash', total: 1000 }],
      creditTotals: [{ _id: 'sales', total: 1000 }],
    });
    const r = await integrity.computeDrift(BIZ);
    expect(r.driftedCount).toBe(0);
    expect(r.totalAbsDrift).toBe(0);
    expect(r.balanced).toBe(true);
    // must query the balance-affecting set (incl. 'reversed'), not REPORT_STATUSES
    expect(txRepo.getDebitCreditTotals).toHaveBeenCalledWith(
      BIZ, expect.any(Date), { statuses: expect.arrayContaining(['posted', 'reversed']) }
    );
  });

  it('detects a drifted account (cached ≠ journal-derived)', async () => {
    accountRepo.findByBusiness.mockResolvedValue([
      { _id: 'cash', accountCode: '1010', accountName: 'Cash', normalBalance: 'Debit', runningBalance: 950 }, // cached 50 short
      { _id: 'sales', accountCode: '4110', accountName: 'Sales', normalBalance: 'Credit', runningBalance: 1000 },
    ]);
    txRepo.getDebitCreditTotals.mockResolvedValue({
      debitTotals: [{ _id: 'cash', total: 1000 }],
      creditTotals: [{ _id: 'sales', total: 1000 }],
    });
    const r = await integrity.computeDrift(BIZ);
    expect(r.driftedCount).toBe(1);
    expect(r.totalAbsDrift).toBe(50);
    const cash = r.accounts.find(a => a.accountId === 'cash');
    expect(cash).toMatchObject({ cached: 950, derived: 1000, drift: -50 });
  });

  it('computes credit-normal balances as credits − debits', async () => {
    accountRepo.findByBusiness.mockResolvedValue([
      { _id: 'loan', accountCode: '2230', accountName: 'Loan', normalBalance: 'Credit', runningBalance: 300 },
    ]);
    txRepo.getDebitCreditTotals.mockResolvedValue({
      debitTotals: [{ _id: 'loan', total: 200 }],   // repayments
      creditTotals: [{ _id: 'loan', total: 500 }],  // borrowings
    });
    const r = await integrity.computeDrift(BIZ);
    const loan = r.accounts.find(a => a.accountId === 'loan');
    expect(loan.derived).toBe(300); // 500 - 200
    expect(loan.drift).toBe(0);
  });

  it('flags the books as unbalanced when total debits ≠ total credits', async () => {
    accountRepo.findByBusiness.mockResolvedValue([
      { _id: 'cash', accountCode: '1010', accountName: 'Cash', normalBalance: 'Debit', runningBalance: 1000 },
    ]);
    txRepo.getDebitCreditTotals.mockResolvedValue({
      debitTotals: [{ _id: 'cash', total: 1000 }],
      creditTotals: [{ _id: 'sales', total: 900 }],
    });
    const r = await integrity.computeDrift(BIZ);
    expect(r.balanced).toBe(false);
  });
});

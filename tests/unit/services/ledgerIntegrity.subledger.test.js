// tests/unit/services/ledgerIntegrity.subledger.test.js
//
// VE-5/VE-6: reconcile the AR/AP party sub-ledger against the ledger, and
// report control-account attribution. The party-balance sum MUST equal the
// customer/vendor-linked open AR/AP remaining balance (the true invariant);
// the control account (1110/2110) may hold additional unattributed direct
// postings (control flag is metadata, not a posting block).
'use strict';

jest.mock('../../../repositories/account.repository');
jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../models/Customer.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../../models/Vendor.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../../models/JournalEntry.model', () => ({ aggregate: jest.fn() }));

const accountRepository = require('../../../repositories/account.repository');
const transactionRepository = require('../../../repositories/transaction.repository');
const Customer = require('../../../models/Customer.model');
const Vendor = require('../../../models/Vendor.model');
const JournalEntry = require('../../../models/JournalEntry.model');
const { computeArApSubledgerDrift } = require('../../../services/ledgerIntegrity.service');

const BIZ = '507f1f77bcf86cd799439099';

// computeDrift() (reused internally) needs accounts + debit/credit totals.
function stubLedger({ arDerived, apDerived }) {
  accountRepository.findByBusiness.mockResolvedValue([
    { _id: 'ar', accountCode: '1110', accountName: 'Accounts Receivable', normalBalance: 'Debit', runningBalance: arDerived },
    { _id: 'ap', accountCode: '2110', accountName: 'Accounts Payable', normalBalance: 'Credit', runningBalance: apDerived },
  ]);
  transactionRepository.getDebitCreditTotals.mockResolvedValue({
    debitTotals:  [{ _id: 'ar', total: arDerived }],
    creditTotals: [{ _id: 'ap', total: apDerived }],
  });
}
const sum = (n) => Promise.resolve(n == null ? [] : [{ sum: n }]);

beforeEach(() => jest.clearAllMocks());

describe('computeArApSubledgerDrift (VE-5/VE-6)', () => {
  it('reconciles when party balances equal the party-linked ledger', async () => {
    stubLedger({ arDerived: 1000, apDerived: 800 });
    Customer.aggregate.mockReturnValue(sum(600));       // Σ customer balances
    JournalEntry.aggregate.mockReturnValueOnce(sum(600)) // AR party-linked remaining
      .mockReturnValueOnce(sum(800));                    // AP party-linked remaining
    Vendor.aggregate.mockReturnValue(sum(800));          // Σ vendor balances

    const r = await computeArApSubledgerDrift(BIZ);
    expect(r.ar.reconciled).toBe(true);
    expect(r.ap.reconciled).toBe(true);
    expect(r.reconciled).toBe(true);
    // 1110 derived 1000 vs 600 party-linked → 400 unattributed direct postings.
    expect(r.ar.unattributed).toBe(400);
    expect(r.ap.unattributed).toBe(0);
  });

  it('flags AR sub-ledger drift when customer balances disagree with the ledger', async () => {
    stubLedger({ arDerived: 1000, apDerived: 0 });
    Customer.aggregate.mockReturnValue(sum(650));        // cached says 650
    JournalEntry.aggregate.mockReturnValueOnce(sum(600)) // ledger says 600
      .mockReturnValueOnce(sum(0));
    Vendor.aggregate.mockReturnValue(sum(0));

    const r = await computeArApSubledgerDrift(BIZ);
    expect(r.ar.reconciled).toBe(false);
    expect(r.ar.subledgerDrift).toBe(50); // 650 cached − 600 ledger
    expect(r.reconciled).toBe(false);
  });

  it('treats empty aggregates as zero (no customers/vendors yet)', async () => {
    stubLedger({ arDerived: 0, apDerived: 0 });
    Customer.aggregate.mockReturnValue(sum(null));
    Vendor.aggregate.mockReturnValue(sum(null));
    JournalEntry.aggregate.mockReturnValue(sum(null));

    const r = await computeArApSubledgerDrift(BIZ);
    expect(r.reconciled).toBe(true);
    expect(r.ar.subledgerSum).toBe(0);
    expect(r.ap.subledgerSum).toBe(0);
  });
});

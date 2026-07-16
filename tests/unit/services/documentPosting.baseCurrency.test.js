/**
 * tests/unit/services/documentPosting.baseCurrency.test.js
 *
 * Audit 2026-07-02 F2 (residual) — document-first recognition posts BASE
 * currency to the ledger.
 *
 * invoice.postArJournal and bill.postApLiabilityJournal passed the document's
 * FOREIGN face amounts (plus currencyCode/exchangeRate annotations) straight
 * to the posters — which do no FX conversion — so a USD 1,000 invoice put
 * 1,000 (not 280,000) into journal lines, running balances and the party
 * balance of a PKR ledger. The ledger, running balances and party balances
 * are ALWAYS base currency (F2 convention); the document keeps the foreign
 * face value for display.
 */
'use strict';

jest.mock('../../../models/ChartOfAccount.model', () => ({ findOne: jest.fn() }));
// AR/AP recognition resolves its control + income/expense accounts by code through
// the resolver, which seeds a missing default instead of skipping the posting.
jest.mock('../../../services/accountResolver.service', () => ({
  resolve: jest.fn(), resolveId: jest.fn(), resolveMany: jest.fn(),
}));
jest.mock('../../../services/ledgerPosting.service', () => ({
  postBalancedJournal: jest.fn(),
  postCompoundJournal: jest.fn(),
}));
jest.mock('../../../services/partyBalance.service', () => ({
  adjustReceivable: jest.fn().mockResolvedValue({}),
  adjustPayable: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../../utils/withTransaction', () => ({ withTransaction: (fn) => fn('SESSION') }));
jest.mock('../../../services/audit.service', () => ({ log: jest.fn(), logCreate: jest.fn() }));
jest.mock('../../../repositories/customer.repository', () => ({ findByBusinessAndId: jest.fn() }));
jest.mock('../../../repositories/vendor.repository', () => ({ findByBusinessAndId: jest.fn() }));
jest.mock('../../../repositories/account.repository', () => ({ findByCode: jest.fn(), syncMissingDefaults: jest.fn() }));
jest.mock('../../../services/billMatching.service', () => ({ validateBill: jest.fn() }));
jest.mock('../../../services/inventory.service', () => ({ reduceStock: jest.fn(), resolveCostAccounts: jest.fn() }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mongoose = require('mongoose');
const ChartOfAccount = require('../../../models/ChartOfAccount.model');
const accountResolver = require('../../../services/accountResolver.service');
const { postBalancedJournal, postCompoundJournal } = require('../../../services/ledgerPosting.service');
const partyBalanceService = require('../../../services/partyBalance.service');
const invoiceService = require('../../../services/invoice.service');
const billService = require('../../../services/bill.service');

const USER = { _id: 'u1' };
const AR_ID = new mongoose.Types.ObjectId();
const REV_ID = new mongoose.Types.ObjectId();
const TAXOUT_ID = new mongoose.Types.ObjectId();
const AP_ID = new mongoose.Types.ObjectId();
const EXP_ID = new mongoose.Types.ObjectId();
const TAXIN_ID = new mongoose.Types.ObjectId();

const lean = (v) => ({ lean: () => Promise.resolve(v) });

beforeEach(() => {
  jest.clearAllMocks();
  postBalancedJournal.mockResolvedValue({ _id: 'je1' });
  postCompoundJournal.mockResolvedValue({ _id: 'je2' });
  // The control account (1110/2110) and the income/expense account are resolved
  // by code; each test's ChartOfAccount stub still supplies everything else.
  // 2120 included since I-3: the output-tax leg fails CLOSED through the
  // resolver instead of silently skipping when the account is missing.
  const byCode = { 1110: AR_ID, 4110: REV_ID, 2110: AP_ID, 6390: EXP_ID, 2120: TAXOUT_ID };
  accountResolver.resolve.mockImplementation(async (_biz, code) => ({ _id: byCode[code], accountCode: code }));
  accountResolver.resolveId.mockImplementation(async (_biz, code) => byCode[code]);
});

describe('invoice.postArJournal — foreign invoice posts base amounts', () => {
  test('USD 1,000 net + 90 tax @280 → AR/revenue/tax journals and the customer balance move in PKR', async () => {
    ChartOfAccount.findOne.mockImplementation((q) => {
      if (q.accountCode === '1110') return lean({ _id: AR_ID });
      if (q.accountCode && q.accountCode.$in && q.accountCode.$in.includes('4110')) return lean({ _id: REV_ID });
      if (q.accountCode && q.accountCode.$in && q.accountCode.$in.includes('2120')) return lean({ _id: TAXOUT_ID });
      return lean(null);
    });

    const invoice = {
      _id: 'inv1', businessId: 'biz1', invoiceNumber: 'INV-FX-1',
      amount: 1000, taxAmount: 90, totalAmount: 1090,
      currencyCode: 'USD', exchangeRate: 280,
      customerId: 'cust1', lineItems: [], issueDate: new Date('2026-06-01'),
      async save() { return this; },
    };

    await invoiceService.postArJournal(invoice, USER, '127.0.0.1');

    // Primary AR/revenue leg: 1,000 × 280 = 280,000 base, base amount pinned
    // explicitly so the model hook can't re-multiply it by the rate.
    expect(postBalancedJournal).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 280000,
        baseCurrencyAmount: 280000,
        currencyCode: 'USD',
        exchangeRate: 280,
        debitAccountId: AR_ID,
      }),
      expect.any(Object)
    );
    // Output-tax leg: 90 × 280 = 25,200 base (taxAmount reported in base too —
    // the return is filed in the functional currency).
    expect(postBalancedJournal).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 25200, baseCurrencyAmount: 25200, taxAmount: 25200 }),
      expect.any(Object)
    );
    // Customer owes the BASE total: 280,000 + 25,200.
    expect(partyBalanceService.adjustReceivable).toHaveBeenCalledWith(
      'biz1', 'cust1', 305200, expect.any(Object)
    );
  });
});

describe('bill.postApLiabilityJournal — foreign bill posts base amounts', () => {
  test('USD 1,000 net + 90 tax @280 → compound AP journal and vendor balance move in PKR', async () => {
    ChartOfAccount.findOne.mockImplementation((q) => {
      if (q.accountCode === '2110') return lean({ _id: AP_ID });
      if (q.accountCode && q.accountCode.$in && q.accountCode.$in.includes('1170')) return lean({ _id: TAXIN_ID });
      return lean(null);
    });

    const bill = {
      _id: 'bill1', businessId: 'biz1', billNumber: 'BILL-FX-1',
      amount: 1000, taxAmount: 90, totalAmount: 1090,
      currencyCode: 'USD', exchangeRate: 280,
      vendorId: 'vend1', purchaseOrderId: null,
      lineItems: [{ accountId: EXP_ID, quantity: 1, unitPrice: 1000 }],
      issueDate: new Date('2026-06-01'),
      async save() { return this; },
    };

    await billService.postApLiabilityJournal(bill, USER, '127.0.0.1');

    expect(postCompoundJournal).toHaveBeenCalledTimes(1);
    const payload = postCompoundJournal.mock.calls[0][0];

    // Every line in base: DR expense 280,000 / DR input tax 25,200 / CR AP 305,200.
    const byType = (t) => payload.lines.filter((l) => l.type === t);
    expect(byType('debit').map((l) => l.amount).sort((a, b) => a - b)).toEqual([25200, 280000]);
    expect(byType('credit')[0].amount).toBe(305200);
    // Base amount pinned explicitly; annotations preserved.
    expect(payload.baseCurrencyAmount).toBe(305200);
    expect(payload.currencyCode).toBe('USD');
    expect(payload.exchangeRate).toBe(280);
    expect(payload.taxAmount).toBe(25200);

    // We owe the vendor the BASE total.
    expect(partyBalanceService.adjustPayable).toHaveBeenCalledWith(
      'biz1', 'vend1', 305200, expect.any(Object)
    );
  });
});

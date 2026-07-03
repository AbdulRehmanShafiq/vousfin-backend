/**
 * tests/unit/services/payment.unappliedAdvance.test.js
 *
 * Audit 2026-07-02 F12 — the on-account (unapplied) portion of a payment must
 * reach the ledger or the payment must fail.
 *
 * _postUnappliedAdvance used to warn-and-skip when the advance account (2190 /
 * 1160) was missing: the Payment document showed the full amount received
 * while the GL only carried the allocated portion — real cash silently absent
 * from the books. Failing loudly rolls the payment back through the caller's
 * compensation path instead.
 */
'use strict';

jest.mock('../../../models/Payment.model', () => ({}));
jest.mock('../../../models/Invoice.model', () => ({}));
jest.mock('../../../models/Bill.model', () => ({}));
jest.mock('../../../models/JournalEntry.model', () => ({}));
jest.mock('../../../models/ChartOfAccount.model', () => ({ findOne: jest.fn() }));
jest.mock('../../../repositories/customer.repository', () => ({}));
jest.mock('../../../repositories/vendor.repository', () => ({}));
jest.mock('../../../services/ledgerPosting.service', () => ({
  postBalancedJournal: jest.fn().mockResolvedValue({ _id: 'adv-je' }),
}));
jest.mock('../../../services/audit.service', () => ({ log: jest.fn() }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ChartOfAccount = require('../../../models/ChartOfAccount.model');
const { postBalancedJournal } = require('../../../services/ledgerPosting.service');
const paymentService = require('../../../services/payment.service');

const PAYMENT = {
  businessId: 'biz1', paymentNumber: 'PAY-1', paymentDate: new Date(),
  currencyCode: 'PKR', exchangeRate: 1,
};
const RESOLVED = {
  direction: 'inbound', partyId: 'cust1', cashAccountId: 'cashAcc', unappliedAmount: 200,
};

const lean = (v) => ({ lean: () => Promise.resolve(v) });

beforeEach(() => jest.clearAllMocks());

describe('F12 — unapplied advance posting fails loudly', () => {
  test('throws when the advance account is missing (cash must never vanish from the GL)', async () => {
    ChartOfAccount.findOne.mockImplementation((q) =>
      lean(q.accountCode ? null : { _id: 'cashAcc' }) // cash resolves, 2190 does not
    );

    await expect(
      paymentService._postUnappliedAdvance(PAYMENT, RESOLVED, 'u1')
    ).rejects.toMatchObject({ statusCode: 500 });

    expect(postBalancedJournal).not.toHaveBeenCalled();
  });

  test('posts the advance journal when both accounts resolve', async () => {
    ChartOfAccount.findOne.mockImplementation((q) =>
      lean(q.accountCode ? { _id: 'advAcc' } : { _id: 'cashAcc' })
    );

    const je = await paymentService._postUnappliedAdvance(PAYMENT, RESOLVED, 'u1');

    expect(je._id).toBe('adv-je');
    expect(postBalancedJournal).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 200, debitAccountId: 'cashAcc', creditAccountId: 'advAcc' }),
      expect.objectContaining({ session: null })
    );
  });
});

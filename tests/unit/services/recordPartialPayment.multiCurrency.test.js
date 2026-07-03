/**
 * tests/unit/services/recordPartialPayment.multiCurrency.test.js
 *
 * Audit 2026-07-02 F2 — ONE currency convention for the settlement engine.
 *
 * A foreign credit sale books its open item in BASE currency:
 * createTransaction sets remainingBalance = baseAmount (e.g. USD 1,000 @ 280 →
 * 280,000 PKR) and the customer balance moves by the same base amount. But the
 * settlement engine subtracted the RAW payment amount (USD units) from that
 * base balance — a USD 1,000 payment against a 280,000-PKR open item left
 * 279,000 "outstanding": the invoice could never settle, the party balance
 * stayed overstated, and the VE-5 reconcile drifted.
 *
 * Convention fixed here: the ledger, remainingBalance, partiallyPaidAmount and
 * party balances are ALWAYS base currency. A foreign payment amount (document
 * currency, as entered by the user) relieves `amount × bookingRate` of base
 * open item — the carrying value under IAS 21 — while the cash leg posts at
 * the settlement rate and the difference books as realised FX (unchanged).
 */
'use strict';

jest.mock('../../../utils/withTransaction', () => ({
  withTransaction: jest.fn((fn) => fn('SESSION')),
}));
jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../services/audit.service');
jest.mock('../../../services/partyBalance.service', () => ({
  adjustReceivable: jest.fn().mockResolvedValue(null),
  adjustPayable: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../services/fx.service', () => ({
  getBaseCurrency: jest.fn().mockResolvedValue('PKR'),
  getRate: jest.fn().mockResolvedValue(285),
}));
jest.mock('../../../models/AccountingPeriod.model', () => ({
  findCoveringPeriod: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const transactionService = require('../../../services/transaction.service');
const transactionRepository = require('../../../repositories/transaction.repository');
const partyBalanceService = require('../../../services/partyBalance.service');
const journalGenerator = require('../../../services/journalGenerator.service');
const { businessEvents } = require('../../../services/businessEventEngine.service');
const { TRANSACTION_TYPES, JOURNAL_STATUS } = require('../../../config/constants');

const BIZ = 'biz1';

// USD 1,000 invoice booked @280 → open item carried at 280,000 PKR (base).
const makeForeignParent = (o = {}) => ({
  _id: 'parent1', businessId: BIZ,
  transactionType: TRANSACTION_TYPES.CREDIT_SALE,
  status: JOURNAL_STATUS.POSTED,
  amount: 1000, currencyCode: 'USD', exchangeRate: 280,
  baseCurrencyAmount: 280000,
  remainingBalance: 280000, partiallyPaidAmount: 0, dueDate: null,
  debitAccountId: { _id: 'AR' }, creditAccountId: { _id: 'SALES' },
  customerId: { _id: 'CUST' }, vendorId: null, invoiceNumber: 'INV-FX',
  ...o,
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(businessEvents, 'emit').mockReturnValue('evt');
  jest.spyOn(transactionService, 'createTransaction').mockResolvedValue({ _id: 'child1' });
  jest.spyOn(journalGenerator, 'generateRealizedFxEntry').mockResolvedValue({ _id: 'fx1' });
  transactionRepository.findByIdWithDetails.mockResolvedValue(makeForeignParent());
  transactionRepository.updateTransaction.mockResolvedValue({});
  transactionRepository.updateTransactionGuarded.mockResolvedValue({ _id: 'parent1' });
});
afterEach(() => jest.restoreAllMocks());

describe('F2 — foreign settlements relieve the BASE open item at the booking rate', () => {
  test('paying the full USD 1,000 settles the 280,000 base open item exactly', async () => {
    await transactionService.recordPartialPayment(
      'parent1', BIZ,
      { amount: 1000, paymentAccountId: 'CASH', transactionDate: new Date('2026-03-01') },
      'u1', '127.0.0.1'
    );

    // 1000 USD × 280 booking = 280,000 base relieved → fully settled.
    expect(transactionRepository.updateTransactionGuarded).toHaveBeenCalledWith(
      'parent1', BIZ,
      { remainingBalance: 280000 },
      expect.objectContaining({
        remainingBalance: 0,
        partiallyPaidAmount: 280000,
        status: JOURNAL_STATUS.SETTLED,
      }),
      'SESSION'
    );

    // The customer's balance unwinds by the BASE amount it was booked with.
    expect(partyBalanceService.adjustReceivable).toHaveBeenCalledWith(
      BIZ, 'CUST', -280000, expect.objectContaining({ session: 'SESSION' })
    );
  });

  test('a partial USD 400 payment relieves 112,000 base (400 × 280 booking rate)', async () => {
    await transactionService.recordPartialPayment(
      'parent1', BIZ,
      { amount: 400, paymentAccountId: 'CASH', transactionDate: new Date('2026-03-01') },
      'u1', '127.0.0.1'
    );

    expect(transactionRepository.updateTransactionGuarded).toHaveBeenCalledWith(
      'parent1', BIZ,
      { remainingBalance: 280000 },
      expect.objectContaining({ remainingBalance: 168000, partiallyPaidAmount: 112000 }),
      'SESSION'
    );
    expect(partyBalanceService.adjustReceivable).toHaveBeenCalledWith(
      BIZ, 'CUST', -112000, expect.anything()
    );
  });

  test('over-payment guard compares in BASE: USD 1,100 against a USD 1,000 open item rejects', async () => {
    await expect(
      transactionService.recordPartialPayment(
        'parent1', BIZ,
        { amount: 1100, paymentAccountId: 'CASH', transactionDate: new Date('2026-03-01') },
        'u1', '127.0.0.1'
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('realised FX still books on the FOREIGN amount settled (unchanged behaviour)', async () => {
    await transactionService.recordPartialPayment(
      'parent1', BIZ,
      { amount: 1000, paymentAccountId: 'CASH', transactionDate: new Date('2026-03-01') },
      'u1', '127.0.0.1'
    );

    // 1000 × (285 − 280) = 5,000 gain — the settlement-rate cash leg vs booked carrying value.
    expect(journalGenerator.generateRealizedFxEntry).toHaveBeenCalledWith(
      expect.objectContaining({ fxAmount: 5000, isGain: true }),
      expect.objectContaining({ session: 'SESSION' })
    );
  });

  test('base-currency settlements are untouched: amount subtracts 1:1', async () => {
    transactionRepository.findByIdWithDetails.mockResolvedValue(makeForeignParent({
      currencyCode: null, exchangeRate: 1, amount: 1000,
      baseCurrencyAmount: 1000, remainingBalance: 1000,
    }));

    await transactionService.recordPartialPayment(
      'parent1', BIZ,
      { amount: 400, paymentAccountId: 'CASH', transactionDate: new Date() },
      'u1', '127.0.0.1'
    );

    expect(transactionRepository.updateTransactionGuarded).toHaveBeenCalledWith(
      'parent1', BIZ,
      { remainingBalance: 1000 },
      expect.objectContaining({ remainingBalance: 600, partiallyPaidAmount: 400 }),
      'SESSION'
    );
    expect(partyBalanceService.adjustReceivable).toHaveBeenCalledWith(
      BIZ, 'CUST', -400, expect.anything()
    );
  });
});

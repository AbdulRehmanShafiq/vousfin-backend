/**
 * tests/unit/services/recordPartialPayment.realisedFx.test.js
 *
 * Settling a FOREIGN-currency AR/AP at a different rate than it was booked must
 * recognise a realised FX gain/loss (IAS 21 §28), posted inside the SAME
 * settlement transaction (one session). The settlement entry itself becomes
 * currency-aware (posts the cash leg at the settlement rate) and the realised FX
 * entry corrects the AR/AP control account back to its booked carrying value.
 *
 * A base-currency settlement (no currencyCode, or currency == base) must NOT
 * touch the FX path at all.
 */
'use strict';

jest.mock('../../../utils/withTransaction', () => ({
  withTransaction: jest.fn((fn) => fn('SESSION')),
}));
jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../services/audit.service');
jest.mock('../../../services/inventory.service');
jest.mock('../../../services/partyBalance.service', () => ({
  adjustReceivable: jest.fn().mockResolvedValue(null),
  adjustPayable:    jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../services/fx.service', () => ({
  getBaseCurrency: jest.fn(),
  getRate:         jest.fn(),
}));
jest.mock('../../../models/AccountingPeriod.model', () => ({
  findCoveringPeriod: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const transactionService    = require('../../../services/transaction.service');
const transactionRepository = require('../../../repositories/transaction.repository');
const fxService             = require('../../../services/fx.service');
const journalGenerator      = require('../../../services/journalGenerator.service');
const { businessEvents }     = require('../../../services/businessEventEngine.service');
const { TRANSACTION_TYPES, JOURNAL_STATUS } = require('../../../config/constants');

const BIZ = 'biz1';
const CASH = 'CASH';

// NOTE (audit F2): remainingBalance is carried in BASE currency. For the
// foreign fixtures (USD @280) the open item is therefore 280,000 — matching
// what createTransaction actually books for a USD 1,000 credit sale.
const makeParent = (o = {}) => ({
  _id: 'parent1', businessId: BIZ,
  transactionType: TRANSACTION_TYPES.CREDIT_SALE,
  status: JOURNAL_STATUS.POSTED,
  remainingBalance: 280000, partiallyPaidAmount: 0, dueDate: null,
  debitAccountId: { _id: 'AR' }, creditAccountId: { _id: 'SALES' },
  customerId: { _id: 'CUST' }, vendorId: null, invoiceNumber: 'INV-1',
  ...o,
});

let fxSpy;
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(businessEvents, 'emit').mockReturnValue('evt');
  jest.spyOn(transactionService, 'createTransaction').mockResolvedValue({ _id: 'child1' });
  transactionRepository.updateTransaction.mockResolvedValue({});
  transactionRepository.updateTransactionGuarded.mockResolvedValue({ _id: 'parent1' });
  fxService.getBaseCurrency.mockResolvedValue('PKR');
  fxSpy = jest.spyOn(journalGenerator, 'generateRealizedFxEntry').mockResolvedValue({ _id: 'fx1' });
});
afterEach(() => jest.restoreAllMocks());

test('foreign AR settled above booking rate posts a realised FX GAIN in the same session', async () => {
  // Booked 1000 USD @280; settling 1000 USD @285 → 5,000 PKR gain.
  transactionRepository.findByIdWithDetails.mockResolvedValue(
    makeParent({ currencyCode: 'USD', exchangeRate: 280 })
  );
  fxService.getRate.mockResolvedValue(285);

  await transactionService.recordPartialPayment(
    'parent1', BIZ, { amount: 1000, paymentAccountId: CASH, transactionDate: new Date('2026-03-01') }, 'u1', '127.0.0.1'
  );

  // Settlement child entry is currency-aware at the SETTLEMENT rate.
  expect(transactionService.createTransaction).toHaveBeenCalledWith(
    expect.objectContaining({ currencyCode: 'USD', exchangeRate: 285 }),
    'u1', '127.0.0.1', 'SESSION'
  );

  // Realised FX gain posted, joined to the SAME session, correcting the AR account.
  expect(fxSpy).toHaveBeenCalledTimes(1);
  const [payload, opts] = fxSpy.mock.calls[0];
  expect(opts).toEqual({ session: 'SESSION' });
  expect(payload).toMatchObject({
    fxAmount: 5000,
    isGain: true,
    isReceivable: true,
    arApAccountId: 'AR',
    parentId: 'parent1',
    settlementId: 'child1',
  });
});

test('honours a caller-supplied settlement exchange rate over the rate table', async () => {
  transactionRepository.findByIdWithDetails.mockResolvedValue(
    makeParent({ currencyCode: 'USD', exchangeRate: 280 })
  );
  fxService.getRate.mockResolvedValue(999); // must be ignored

  await transactionService.recordPartialPayment(
    'parent1', BIZ, { amount: 1000, paymentAccountId: CASH, exchangeRate: 290, transactionDate: new Date('2026-03-01') }, 'u1', '127.0.0.1'
  );

  const [payload] = fxSpy.mock.calls[0];
  expect(payload.fxAmount).toBe(10000); // 1000 × (290 − 280)
  expect(fxService.getRate).not.toHaveBeenCalled();
});

test('base-currency settlement does NOT touch the FX path', async () => {
  transactionRepository.findByIdWithDetails.mockResolvedValue(makeParent()); // no currencyCode

  await transactionService.recordPartialPayment(
    'parent1', BIZ, { amount: 100, paymentAccountId: CASH, transactionDate: new Date() }, 'u1', '127.0.0.1'
  );

  expect(fxService.getBaseCurrency).not.toHaveBeenCalled();
  expect(fxSpy).not.toHaveBeenCalled();
  expect(transactionService.createTransaction).toHaveBeenCalledWith(
    expect.not.objectContaining({ currencyCode: expect.anything() }),
    'u1', '127.0.0.1', 'SESSION'
  );
});

test('no realised FX when settlement rate equals booking rate', async () => {
  transactionRepository.findByIdWithDetails.mockResolvedValue(
    makeParent({ currencyCode: 'USD', exchangeRate: 280 })
  );
  fxService.getRate.mockResolvedValue(280); // no movement

  await transactionService.recordPartialPayment(
    'parent1', BIZ, { amount: 1000, paymentAccountId: CASH, transactionDate: new Date() }, 'u1', '127.0.0.1'
  );

  expect(fxSpy).not.toHaveBeenCalled();
});

/**
 * tests/unit/services/journalGenerator.realisedFx.test.js
 *
 * Realised FX on settlement of a foreign-currency monetary item (IAS 21 §28):
 * the exchange difference between the BOOKING rate and the SETTLEMENT rate is
 * recognised in profit or loss.
 *
 *   realised FX amount = |settlementRate − bookingRate| × foreignAmountSettled
 *
 *   AR (asset):     settle > booking → GAIN (received more base than carried)
 *                   settle < booking → LOSS
 *   AP (liability): settle > booking → LOSS (paid more base than carried)
 *                   settle < booking → GAIN
 *
 * computeRealisedFx is a PURE helper (no I/O) so all four quadrants — plus the
 * zero-difference and sub-cent-dust no-op cases — are exhaustively unit-tested,
 * mirroring buildUnrealisedFxRevaluation (audit A2).
 */
'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../utils/reportCache', () => ({ invalidate: jest.fn() }));
jest.mock('../../../services/ledgerPosting.service', () => ({
  postCompoundJournal: jest.fn(),
  applyRunningBalance: jest.fn(),
}));
jest.mock('../../../services/fx.service', () => ({ getBaseCurrency: jest.fn(), getRate: jest.fn(), round: (v) => v }));
jest.mock('../../../models/ChartOfAccount.model', () => ({ find: jest.fn() }));
jest.mock('../../../models/JournalEntry.model', () => ({ create: jest.fn(), find: jest.fn(), findOne: jest.fn(), findByIdAndUpdate: jest.fn() }));

const journalGenerator = require('../../../services/journalGenerator.service');
const { computeRealisedFx } = journalGenerator;
const { postCompoundJournal } = require('../../../services/ledgerPosting.service');
const ChartOfAccount = require('../../../models/ChartOfAccount.model');

const GAIN = 'gain-4140', LOSS = 'loss-6200', UNR = 'unr-6210';
const AR = 'ar-acct', AP = 'ap-acct';

describe('computeRealisedFx (audit A5 — realised FX on settlement)', () => {
  test('AR settled above booking rate → GAIN', () => {
    const r = computeRealisedFx({ isReceivable: true, foreignAmountSettled: 1000, bookingRate: 280, settlementRate: 285 });
    expect(r.isGain).toBe(true);
    expect(r.fxAmount).toBe(5000); // 1000 × (285 − 280)
    expect(r.hasFx).toBe(true);
  });

  test('AR settled below booking rate → LOSS', () => {
    const r = computeRealisedFx({ isReceivable: true, foreignAmountSettled: 1000, bookingRate: 285, settlementRate: 280 });
    expect(r.isGain).toBe(false);
    expect(r.fxAmount).toBe(5000);
    expect(r.hasFx).toBe(true);
  });

  test('AP settled above booking rate (paid more) → LOSS', () => {
    const r = computeRealisedFx({ isReceivable: false, foreignAmountSettled: 1000, bookingRate: 280, settlementRate: 285 });
    expect(r.isGain).toBe(false);
    expect(r.fxAmount).toBe(5000);
    expect(r.hasFx).toBe(true);
  });

  test('AP settled below booking rate (paid less) → GAIN', () => {
    const r = computeRealisedFx({ isReceivable: false, foreignAmountSettled: 1000, bookingRate: 285, settlementRate: 280 });
    expect(r.isGain).toBe(true);
    expect(r.fxAmount).toBe(5000);
    expect(r.hasFx).toBe(true);
  });

  test('partial settlement only books FX on the amount settled', () => {
    const r = computeRealisedFx({ isReceivable: true, foreignAmountSettled: 250, bookingRate: 280, settlementRate: 284 });
    expect(r.fxAmount).toBe(1000); // 250 × 4
    expect(r.isGain).toBe(true);
  });

  test('no rate movement → no FX (hasFx false)', () => {
    const r = computeRealisedFx({ isReceivable: true, foreignAmountSettled: 1000, bookingRate: 280, settlementRate: 280 });
    expect(r.fxAmount).toBe(0);
    expect(r.hasFx).toBe(false);
  });

  test('sub-cent dust is treated as no FX', () => {
    const r = computeRealisedFx({ isReceivable: true, foreignAmountSettled: 1, bookingRate: 280, settlementRate: 280.0001 });
    expect(r.hasFx).toBe(false);
  });
});

describe('generateRealizedFxEntry — atomic, idempotent posting (audit A5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ChartOfAccount.find.mockReturnValue({
      lean: async () => ([
        { accountCode: '4140', _id: GAIN },
        { accountCode: '6200', _id: LOSS },
        { accountCode: '6210', _id: UNR },
      ]),
    });
    postCompoundJournal.mockResolvedValue({ _id: 'je1' });
  });

  test('posts a GAIN through postCompoundJournal: DR AR / CR FX Gain, idempotency + session', async () => {
    await journalGenerator.generateRealizedFxEntry({
      businessId: 'biz1', transactionDate: new Date('2026-03-01'),
      fxAmount: 5000, isGain: true, isReceivable: true, arApAccountId: AR,
      userId: 'u1', parentId: 'parent1', settlementId: 'child1',
    }, { session: 'S' });

    expect(postCompoundJournal).toHaveBeenCalledTimes(1);
    const [payload, opts] = postCompoundJournal.mock.calls[0];
    expect(opts).toEqual({ session: 'S' });
    expect(payload.idempotencyKey).toBe('fx:realised:parent1:child1');
    expect(payload.lines).toEqual([
      { accountId: AR,   type: 'debit',  amount: 5000 },
      { accountId: GAIN, type: 'credit', amount: 5000 },
    ]);
  });

  test('AP loss posts DR FX Loss / CR AP (direction follows isGain, not a receivable flip)', async () => {
    await journalGenerator.generateRealizedFxEntry({
      businessId: 'biz1', transactionDate: new Date('2026-03-01'),
      fxAmount: 5000, isGain: false, isReceivable: false, arApAccountId: AP,
      userId: 'u1', parentId: 'p2', settlementId: 'c2',
    });

    const [payload] = postCompoundJournal.mock.calls[0];
    expect(payload.lines).toEqual([
      { accountId: LOSS, type: 'debit',  amount: 5000 },
      { accountId: AP,   type: 'credit', amount: 5000 },
    ]);
  });

  test('zero fxAmount posts nothing', async () => {
    const res = await journalGenerator.generateRealizedFxEntry({
      businessId: 'biz1', transactionDate: new Date(), fxAmount: 0,
      isGain: true, isReceivable: true, arApAccountId: AR, userId: 'u1',
    });
    expect(res).toBeNull();
    expect(postCompoundJournal).not.toHaveBeenCalled();
  });
});

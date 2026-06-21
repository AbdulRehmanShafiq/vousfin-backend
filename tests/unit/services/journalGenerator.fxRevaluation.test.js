/**
 * Regression for audit finding A2 — unrealised FX month-end revaluation must
 * book the correct direction for BOTH receivables (assets) and payables
 * (liabilities) per IAS 21 §23(a).
 *
 *   AR (asset):     base value UP  (diff>0) = GAIN  → DR AR / CR Unrealised
 *                   base value DOWN(diff<0) = LOSS  → DR Unrealised / CR AR
 *   AP (liability): base value UP  (diff>0) = LOSS  → DR Unrealised / CR AP
 *                   base value DOWN(diff<0) = GAIN  → DR AP / CR Unrealised
 *
 * The prior code used `isGain = diff > 0` and an identical AR/AP branch, so it
 * booked payables backwards (a loss recorded as a gain, AP reduced instead of
 * increased).
 */
'use strict';

const { buildUnrealisedFxRevaluation } = require('../../../services/journalGenerator.service');

const MON = 'monetary-acct';   // the AR or AP control account
const UNR = 'unrealised-6210'; // FX unrealised revaluation account

describe('buildUnrealisedFxRevaluation (audit A2)', () => {
  test('AR value rises → GAIN, DR AR / CR Unrealised', () => {
    const r = buildUnrealisedFxRevaluation({ isAR: true, diff: 500, monetaryAccId: MON, unrealisedAccId: UNR });
    expect(r.isGain).toBe(true);
    expect(r.absAmt).toBe(500);
    expect(r.debitId).toBe(MON);
    expect(r.creditId).toBe(UNR);
  });

  test('AR value falls → LOSS, DR Unrealised / CR AR', () => {
    const r = buildUnrealisedFxRevaluation({ isAR: true, diff: -300, monetaryAccId: MON, unrealisedAccId: UNR });
    expect(r.isGain).toBe(false);
    expect(r.absAmt).toBe(300);
    expect(r.debitId).toBe(UNR);
    expect(r.creditId).toBe(MON);
  });

  test('AP value rises (owe more) → LOSS, DR Unrealised / CR AP', () => {
    const r = buildUnrealisedFxRevaluation({ isAR: false, diff: 400, monetaryAccId: MON, unrealisedAccId: UNR });
    expect(r.isGain).toBe(false);
    expect(r.absAmt).toBe(400);
    expect(r.debitId).toBe(UNR);   // loss
    expect(r.creditId).toBe(MON);  // liability INCREASES
  });

  test('AP value falls (owe less) → GAIN, DR AP / CR Unrealised', () => {
    const r = buildUnrealisedFxRevaluation({ isAR: false, diff: -250, monetaryAccId: MON, unrealisedAccId: UNR });
    expect(r.isGain).toBe(true);
    expect(r.absAmt).toBe(250);
    expect(r.debitId).toBe(MON);   // liability DECREASES
    expect(r.creditId).toBe(UNR);  // gain
  });
});

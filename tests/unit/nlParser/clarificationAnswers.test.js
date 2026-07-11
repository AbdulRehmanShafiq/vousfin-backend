'use strict';
const { ANSWER_OPTIONS, detectAnswers } = require('../../../services/nlParser/constants/clarificationAnswers');

describe('detectAnswers', () => {
  test('detects each intent answer literal', () => {
    expect(detectAnswers(`bought rice\n\nAdditional details:\n- Will you sell this again? ${ANSWER_OPTIONS.RESALE}`).intentAnswer).toBe('resale');
    expect(detectAnswers(`x ${ANSWER_OPTIONS.BUSINESS_USE}`).intentAnswer).toBe('business_use');
    expect(detectAnswers(`x ${ANSWER_OPTIONS.ASSET}`).intentAnswer).toBe('long_term_asset');
  });

  test('detects item-consent answers', () => {
    expect(detectAnswers(`x ${ANSWER_OPTIONS.ADD_ITEM_YES}`).itemConsent).toBe(true);
    expect(detectAnswers(`x ${ANSWER_OPTIONS.ADD_ITEM_NO}`).itemConsent).toBe(false);
  });

  test('no answers present → nulls', () => {
    expect(detectAnswers('bought 10 bags of rice for 5000')).toEqual({ intentAnswer: null, itemConsent: null });
    expect(detectAnswers('')).toEqual({ intentAnswer: null, itemConsent: null });
  });

  test('detection is case-insensitive', () => {
    expect(detectAnswers("SELL IT AGAIN (IT'S STOCK)").intentAnswer).toBe('resale');
  });
});

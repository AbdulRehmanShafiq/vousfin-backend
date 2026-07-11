'use strict';
const { buildClarification, DEFAULT_MAX_ROUNDS } = require('../../../services/nlParser/utils/clarificationBuilder');
const { ANSWER_OPTIONS } = require('../../../services/nlParser/constants/clarificationAnswers');

const CONF = { overall: 0.9, intent: 0.9, amount: 0.9, date: 0.9, accountMapping: 0.9 };
const DATA = {
  amount: 5000, paymentMethod: 'cash', cashFlowDirection: 'outflow',
  lineItems: [{ name: 'flour', quantity: 20, unit: 'bags', unitPrice: 250 }],
  counterpartyName: null, creditAccount: null,
};

describe('clarification sequencing — smart entry', () => {
  test('round cap is now 3', () => {
    expect(DEFAULT_MAX_ROUNDS).toBe(3);
  });

  test('classification question fires with the three canonical options', () => {
    const c = buildClarification(CONF, DATA, {
      attempt: 0,
      intentResolution: { needsClassificationQuestion: true, needsItemConsent: false, needsQuantity: false },
    });
    expect(c.field).toBe('purchaseIntent');
    expect(c.options).toEqual([ANSWER_OPTIONS.RESALE, ANSWER_OPTIONS.BUSINESS_USE, ANSWER_OPTIONS.ASSET]);
  });

  test('item consent question names the item and offers yes/no literals', () => {
    const c = buildClarification(CONF, DATA, {
      attempt: 1,
      intentResolution: { needsClassificationQuestion: false, needsItemConsent: true, needsQuantity: false },
    });
    expect(c.field).toBe('newItemConsent');
    expect(c.question).toContain('flour');
    expect(c.options).toEqual([ANSWER_OPTIONS.ADD_ITEM_YES, ANSWER_OPTIONS.ADD_ITEM_NO]);
  });

  test('quantity question is free-text (no options)', () => {
    const c = buildClarification(CONF, DATA, {
      attempt: 1,
      intentResolution: { needsClassificationQuestion: false, needsItemConsent: false, needsQuantity: true },
    });
    expect(c.field).toBe('inventoryQuantity');
    expect(c.options).toBeUndefined();
  });

  test('vendor question fires for a credit purchase without a counterparty', () => {
    const c = buildClarification(CONF, { ...DATA, creditAccount: 'Accounts Payable' }, {
      attempt: 0,
      intentResolution: { needsClassificationQuestion: false, needsItemConsent: false, needsQuantity: false },
    });
    expect(c.field).toBe('vendorName');
  });

  test('amount still wins over everything', () => {
    const c = buildClarification(CONF, { ...DATA, amount: null }, {
      attempt: 0,
      intentResolution: { needsClassificationQuestion: true },
    });
    expect(c.field).toBe('amount');
  });

  test('round cap still terminates the loop', () => {
    const c = buildClarification(CONF, DATA, {
      attempt: 3,
      intentResolution: { needsClassificationQuestion: true },
    });
    expect(c).toBeNull();
  });

  test('nothing needed → null (no intentResolution supplied)', () => {
    expect(buildClarification(CONF, DATA, { attempt: 0 })).toBeNull();
  });
});

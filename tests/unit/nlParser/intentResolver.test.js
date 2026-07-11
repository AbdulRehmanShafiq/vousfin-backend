'use strict';
const { resolveIntent, buildInventoryBlock, INTENT_TO_TYPE } = require('../../../services/nlParser/services/intentResolver');
const { ANSWER_OPTIONS } = require('../../../services/nlParser/constants/clarificationAnswers');

const ITEMS = [{ _id: 'i1', name: 'Rice (bag)', unit: 'bags', unitCostPrice: 480, currentStock: 12 }];

const base = (over = {}) => ({
  transactionType: 'expense', amount: 5000, lineItems: [], purchaseIntent: null,
  saleAffectsStock: false, ...over,
});

describe('resolveIntent — purchase decision table', () => {
  test('row 1: item matches existing inventory → resale, no question', () => {
    const r = resolveIntent(
      base({ lineItems: [{ name: 'rice', quantity: 10, unit: 'bags', unitPrice: 500 }] }),
      { rawText: 'bought 10 bags of rice for 5000', inventoryItems: ITEMS }
    );
    expect(r.classification).toBe('resale');
    expect(r.matchedItem.item._id).toBe('i1');
    expect(r.needsClassificationQuestion).toBe(false);
  });

  test('row 2: explicit resale cue ("stock") → resale even with no match', () => {
    const r = resolveIntent(
      base({ lineItems: [{ name: 'diesel', quantity: 100, unit: 'litres', unitPrice: 50 }] }),
      { rawText: 'bought diesel stock for the shop 5000', inventoryItems: ITEMS }
    );
    expect(r.classification).toBe('resale');
  });

  test('row 3: asset intent from the AI → long_term_asset', () => {
    const r = resolveIntent(
      base({ purchaseIntent: 'long_term_asset', lineItems: [{ name: 'office chair', quantity: 2, unit: 'units', unitPrice: 2500 }] }),
      { rawText: 'bought 2 office chairs for 5000', inventoryItems: ITEMS }
    );
    expect(r.classification).toBe('long_term_asset');
  });

  test('row 4: business tracks NO stock and no cues → business_use, no question', () => {
    const r = resolveIntent(
      base({ lineItems: [{ name: 'paper', quantity: 10, unit: 'reams', unitPrice: 500 }] }),
      { rawText: 'bought 10 reams of paper for 5000', inventoryItems: [] }
    );
    expect(r.classification).toBe('business_use');
    expect(r.needsClassificationQuestion).toBe(false);
  });

  test('row 5: tracks stock + goods parsed + no match + AI unsure → ASK', () => {
    const r = resolveIntent(
      base({ lineItems: [{ name: 'flour', quantity: 20, unit: 'bags', unitPrice: 250 }] }),
      { rawText: 'bought 20 bags of flour for 5000', inventoryItems: ITEMS }
    );
    expect(r.classification).toBeNull();
    expect(r.needsClassificationQuestion).toBe(true);
  });

  test('user answer beats everything', () => {
    const r = resolveIntent(
      base({ lineItems: [{ name: 'flour', quantity: 20, unit: 'bags', unitPrice: 250 }] }),
      { rawText: `bought flour\n\nAdditional details:\n- Q ${ANSWER_OPTIONS.BUSINESS_USE}`, inventoryItems: ITEMS }
    );
    expect(r.classification).toBe('business_use');
    expect(r.needsClassificationQuestion).toBe(false);
  });
});

describe('resolveIntent — item consent + quantity follow-ups', () => {
  test('resale + no match + no consent yet → needsItemConsent', () => {
    const r = resolveIntent(
      base({ lineItems: [{ name: 'flour', quantity: 20, unit: 'bags', unitPrice: 250 }] }),
      { rawText: 'bought flour stock', inventoryItems: ITEMS }
    );
    expect(r.classification).toBe('resale');
    expect(r.needsItemConsent).toBe(true);
  });

  test('consent yes + quantity missing → needsQuantity', () => {
    const r = resolveIntent(
      base({ lineItems: [{ name: 'flour', quantity: null, unit: null, unitPrice: null }] }),
      { rawText: `bought flour stock\n\nAdditional details:\n- Add? ${ANSWER_OPTIONS.ADD_ITEM_YES}`, inventoryItems: ITEMS }
    );
    expect(r.itemConsent).toBe(true);
    expect(r.needsItemConsent).toBe(false);
    expect(r.needsQuantity).toBe(true);
  });

  test('consent no → no follow-ups, records without stock tracking', () => {
    const r = resolveIntent(
      base({ lineItems: [{ name: 'flour', quantity: 20, unit: 'bags', unitPrice: 250 }] }),
      { rawText: `bought flour stock\n\nAdditional details:\n- Add? ${ANSWER_OPTIONS.ADD_ITEM_NO}`, inventoryItems: ITEMS }
    );
    expect(r.needsItemConsent).toBe(false);
    expect(r.needsQuantity).toBe(false);
  });

  test('matched item + quantity missing → needsQuantity', () => {
    const r = resolveIntent(
      base({ lineItems: [{ name: 'rice', quantity: null, unit: null, unitPrice: null }] }),
      { rawText: 'bought rice for 5000', inventoryItems: ITEMS }
    );
    expect(r.needsQuantity).toBe(true);
  });
});

describe('resolveIntent — sales', () => {
  test('sale of a matched item → sale_of_stock', () => {
    const r = resolveIntent(
      base({ transactionType: 'inventory_sale', saleAffectsStock: true,
             lineItems: [{ name: 'rice', quantity: 5, unit: 'bags', unitPrice: 800 }] }),
      { rawText: 'sold 5 bags of rice for 4000', inventoryItems: ITEMS }
    );
    expect(r.classification).toBe('sale_of_stock');
    expect(r.matchedItem.item._id).toBe('i1');
  });

  test('service income never touches stock', () => {
    const r = resolveIntent(
      base({ transactionType: 'income', saleAffectsStock: false }),
      { rawText: 'received 25000 for consulting', inventoryItems: ITEMS }
    );
    expect(r.classification).toBeNull();
  });
});

describe('buildInventoryBlock', () => {
  test('matched purchase → mode existing with item linkage', () => {
    const normalized = base({ lineItems: [{ name: 'rice', quantity: 10, unit: 'bags', unitPrice: 500 }] });
    const r = resolveIntent(normalized, { rawText: 'bought 10 bags rice 5000', inventoryItems: ITEMS });
    const inv = buildInventoryBlock(normalized, r);
    expect(inv).toEqual({
      mode: 'existing', itemId: 'i1', itemName: 'Rice (bag)', quantity: 10,
      unit: 'bags', unitCostPrice: 500, currentStock: 12,
    });
  });

  test('consented new item → mode create', () => {
    const normalized = base({ lineItems: [{ name: 'flour', quantity: 20, unit: 'bags', unitPrice: 250 }] });
    const r = resolveIntent(normalized, {
      rawText: `bought flour stock\n\nAdditional details:\n- Add? ${ANSWER_OPTIONS.ADD_ITEM_YES}`,
      inventoryItems: ITEMS,
    });
    const inv = buildInventoryBlock(normalized, r);
    expect(inv).toEqual({ mode: 'create', itemName: 'flour', quantity: 20, unit: 'bags', unitCostPrice: 250 });
  });

  test('business_use → mode none', () => {
    const normalized = base({ lineItems: [{ name: 'paper', quantity: 10, unit: 'reams', unitPrice: 500 }] });
    const r = resolveIntent(normalized, { rawText: 'bought paper', inventoryItems: [] });
    expect(buildInventoryBlock(normalized, r)).toEqual({ mode: 'none' });
  });
});

describe('INTENT_TO_TYPE', () => {
  test('maps every purchase classification to an NL transaction type', () => {
    expect(INTENT_TO_TYPE).toEqual({
      resale: 'inventory_purchase', business_use: 'expense', long_term_asset: 'asset_purchase',
    });
  });
});

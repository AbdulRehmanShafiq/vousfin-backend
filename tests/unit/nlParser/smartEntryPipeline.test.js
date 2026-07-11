'use strict';
jest.mock('../../../services/nlParser/services/aiExtractionService', () => ({
  callAIExtraction: jest.fn(),
  callAIVision: jest.fn(),
}));
const { callAIExtraction } = require('../../../services/nlParser/services/aiExtractionService');
const { parseTransaction } = require('../../../services/nlParser/services/parserService');
const { ANSWER_OPTIONS } = require('../../../services/nlParser/constants/clarificationAnswers');

const ITEMS = [{ _id: 'i1', name: 'Rice (bag)', unit: 'bags', unitCostPrice: 480, currentStock: 12 }];
const CONF = { intent: 0.95, amount: 0.95, date: 0.95, accountMapping: 0.95 };

const extraction = (over = {}) => ({
  intent: 'purchase', transactionType: 'expense', subcategory: null, amount: 5000,
  currency: 'PKR', date: '2026-07-10', description: 'Bought goods',
  counterpartyName: null, paymentMethod: 'cash', sourceAccount: 'Cash in Hand',
  debitAccount: 'General Expenses', creditAccount: 'Cash in Hand',
  cashFlowDirection: 'outflow', lineItems: [], purchaseIntent: null,
  saleAffectsStock: false, isInstallment: false, confidence: CONF, ...over,
});

describe('smart entry pipeline', () => {
  beforeEach(() => jest.clearAllMocks());

  test('matched item reclassifies expense → inventory_purchase and links the item', async () => {
    callAIExtraction.mockResolvedValue(extraction({
      lineItems: [{ name: 'rice', quantity: 10, unit: 'bags', unitPrice: 500 }],
    }));
    const r = await parseTransaction('bought 10 bags of rice for 5000 cash', [], { inventoryItems: ITEMS });
    expect(r.parsedData.transactionType).toBe('inventory_purchase');
    expect(r.parsedData.inventory).toMatchObject({ mode: 'existing', itemId: 'i1', quantity: 10 });
    expect(r.needsClarification).toBe(false);
  });

  test('the word "inventory" alone no longer forces stock: business_use answer reroutes to expense', async () => {
    callAIExtraction.mockResolvedValue(extraction({
      transactionType: 'inventory_purchase', debitAccount: 'Inventory',
      lineItems: [{ name: 'printer paper', quantity: 10, unit: 'reams', unitPrice: 500 }],
    }));
    const raw = `bought inventory of printer paper 5000\n\nAdditional details:\n- Q ${ANSWER_OPTIONS.BUSINESS_USE}`;
    const r = await parseTransaction(raw, [], { inventoryItems: ITEMS });
    expect(r.parsedData.transactionType).toBe('expense');
    expect(r.parsedData.inventory.mode).toBe('none');
    // the Inventory debit hint must not survive a business_use classification
    expect(r.parsedData.debitAccount || '').not.toMatch(/inventory/i);
  });

  test('unknown goods + tracked stock + unsure AI → asks the classification question', async () => {
    callAIExtraction.mockResolvedValue(extraction({
      lineItems: [{ name: 'flour', quantity: 20, unit: 'bags', unitPrice: 250 }],
    }));
    const r = await parseTransaction('bought 20 bags of flour for 5000 cash', [], { inventoryItems: ITEMS });
    expect(r.needsClarification).toBe(true);
    expect(r.clarification.field).toBe('purchaseIntent');
  });

  test('consented creation lands in parsedData.inventory as mode create', async () => {
    callAIExtraction.mockResolvedValue(extraction({
      lineItems: [{ name: 'flour', quantity: 20, unit: 'bags', unitPrice: 250 }],
    }));
    const raw = `bought 20 bags of flour stock for 5000 cash\n\nAdditional details:\n- Add? ${ANSWER_OPTIONS.ADD_ITEM_YES}`;
    const r = await parseTransaction(raw, [], { inventoryItems: ITEMS });
    expect(r.parsedData.transactionType).toBe('inventory_purchase');
    expect(r.parsedData.inventory).toMatchObject({ mode: 'create', itemName: 'flour', quantity: 20 });
  });

  test('resale classification steers the debit hint to Inventory', async () => {
    callAIExtraction.mockResolvedValue(extraction({
      lineItems: [{ name: 'rice', quantity: 10, unit: 'bags', unitPrice: 500 }],
    }));
    const r = await parseTransaction('bought 10 bags of rice for 5000 cash', [], { inventoryItems: ITEMS });
    expect(r.parsedData.debitAccount).toBe('Inventory');
  });

  test('sale of matched stock exposes inventory for the COGS path', async () => {
    callAIExtraction.mockResolvedValue(extraction({
      transactionType: 'inventory_sale', cashFlowDirection: 'inflow', saleAffectsStock: true,
      debitAccount: 'Cash in Hand', creditAccount: 'Sales Revenue',
      lineItems: [{ name: 'rice', quantity: 5, unit: 'bags', unitPrice: 800 }], amount: 4000,
    }));
    const r = await parseTransaction('sold 5 bags of rice for 4000 cash', [], { inventoryItems: ITEMS });
    expect(r.parsedData.inventory).toMatchObject({ mode: 'existing', itemId: 'i1', quantity: 5 });
  });
});

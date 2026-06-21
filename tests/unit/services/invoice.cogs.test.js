/**
 * tests/unit/services/invoice.cogs.test.js
 *
 * ERP Integration Refactor — Step 5 (Invoice ↔ Inventory).
 * Validates invoice-first COGS recognition: on AR recognition, each product
 * line reduces inventory and a single consolidated DR COGS / CR Inventory
 * journal is posted at weighted-average cost. Service-only test — inventory
 * engine and the ledger poster are stubbed.
 */
'use strict';

jest.mock('../../../services/inventory.service', () => ({
  reduceStock: jest.fn(),
  resolveCostAccounts: jest.fn(),
}));
jest.mock('../../../services/ledgerPosting.service', () => ({
  postBalancedJournal: jest.fn().mockResolvedValue({ _id: 'je-cogs' }),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const invoiceService   = require('../../../services/invoice.service');
const inventoryService  = require('../../../services/inventory.service');
const { postBalancedJournal } = require('../../../services/ledgerPosting.service');

const USER = { _id: 'u1' };
const BIZ  = 'biz1';

beforeEach(() => jest.clearAllMocks());

describe('invoiceService._applyCogsForInvoice() — ERP Step 5', () => {
  test('reduces stock per product line and posts ONE consolidated COGS journal', async () => {
    inventoryService.reduceStock
      .mockResolvedValueOnce({ cogsAmount: 300, unitCostUsed: 100, updatedStock: 7 })
      .mockResolvedValueOnce({ cogsAmount: 80,  unitCostUsed: 40,  updatedStock: 2 });
    inventoryService.resolveCostAccounts.mockResolvedValue({ cogsAccountId: 'cogs', inventoryAccountId: 'inv' });

    const invoice = {
      _id: 'inv1', businessId: BIZ, invoiceNumber: 'INV-1', issueDate: new Date(),
      currencyCode: 'PKR', customerId: 'c1',
      lineItems: [
        { inventoryItemId: 'item1', quantity: 3 },
        { inventoryItemId: 'item2', quantity: 2 },
        { quantity: 5 }, // service line — no inventoryItemId → skipped
      ],
    };

    const total = await invoiceService._applyCogsForInvoice(invoice, USER);

    expect(inventoryService.reduceStock).toHaveBeenCalledTimes(2);
    expect(inventoryService.reduceStock).toHaveBeenCalledWith(BIZ, 'item1', 3, null);
    expect(inventoryService.reduceStock).toHaveBeenCalledWith(BIZ, 'item2', 2, null);
    expect(total).toBe(380);

    expect(postBalancedJournal).toHaveBeenCalledTimes(1);
    const [je, jeOpts] = postBalancedJournal.mock.calls[0];
    expect(je.debitAccountId).toBe('cogs');     // DR Cost of Goods Sold
    expect(je.creditAccountId).toBe('inv');     // CR Inventory
    expect(je.amount).toBe(380);
    expect(jeOpts).toEqual({ session: null });  // session threaded through
  });

  test('no product lines → no stock reduction and no journal', async () => {
    const invoice = { businessId: BIZ, invoiceNumber: 'INV-2', lineItems: [{ quantity: 5 }] };
    const res = await invoiceService._applyCogsForInvoice(invoice, USER);
    expect(res).toBeNull();
    expect(inventoryService.reduceStock).not.toHaveBeenCalled();
    expect(postBalancedJournal).not.toHaveBeenCalled();
  });

  test('still reduces stock but skips the journal when COGS/Inventory accounts are missing', async () => {
    inventoryService.reduceStock.mockResolvedValue({ cogsAmount: 100 });
    inventoryService.resolveCostAccounts.mockResolvedValue({ cogsAccountId: null, inventoryAccountId: null });

    const invoice = {
      businessId: BIZ, invoiceNumber: 'INV-3', issueDate: new Date(),
      lineItems: [{ inventoryItemId: 'item1', quantity: 1 }],
    };
    const total = await invoiceService._applyCogsForInvoice(invoice, USER);

    expect(inventoryService.reduceStock).toHaveBeenCalledTimes(1);
    expect(inventoryService.reduceStock).toHaveBeenCalledWith(BIZ, 'item1', 1, null);
    expect(postBalancedJournal).not.toHaveBeenCalled();
    expect(total).toBe(100); // stock already reduced — caller still informed
  });
});

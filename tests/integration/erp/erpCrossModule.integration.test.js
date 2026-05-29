/**
 * tests/integration/erp/erpCrossModule.integration.test.js
 *
 * ERP Integration Refactor — Step 11: 10 cross-module validation scenarios.
 *
 * These exercise the REAL integration fabric wired in Steps 2–9 — the business
 * event engine, its analytics-cache subscribers, the centralized party-balance
 * engine, the shared balanced-journal poster, the unified audit timeline and the
 * tax-account seeder — together. Only the persistence boundary (repositories /
 * Mongoose models / report cache) is mocked, so each test proves that a business
 * action actually PROPAGATES across module seams, not just that a unit works in
 * isolation.
 */
'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../utils/reportCache', () => ({ invalidate: jest.fn(), get: jest.fn(), set: jest.fn(), clear: jest.fn() }));
jest.mock('../../../repositories/customer.repository', () => ({ updateReceivableBalance: jest.fn() }));
jest.mock('../../../repositories/vendor.repository',   () => ({ updatePayableBalance:    jest.fn() }));
jest.mock('../../../repositories/account.repository',  () => ({ findById: jest.fn(), updateRunningBalance: jest.fn() }));
jest.mock('../../../repositories/auditLog.repository', () => ({ getByBusiness: jest.fn(), getForEntity: jest.fn() }));
jest.mock('../../../repositories/user.repository',     () => ({ findById: jest.fn() }));
jest.mock('../../../models/JournalEntry.model',        () => ({ create: jest.fn() }));
jest.mock('../../../models/ChartOfAccount.model',      () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../../../models/Business.model',            () => ({ findById: jest.fn() }));
// Inventory engine is mocked at its boundary; the procurement/sales SERVICES that
// call it are real, so we validate the wiring between them.
jest.mock('../../../services/inventory.service', () => ({
  applyPurchaseStock: jest.fn().mockResolvedValue({ item: {} }),
  reduceStock: jest.fn(),
  resolveCostAccounts: jest.fn(),
}));

// ── Real integration fabric ──────────────────────────────────────────────────
const { businessEvents, EVENTS } = require('../../../services/businessEventEngine.service');
const eventSubscribers   = require('../../../services/eventSubscribers.service');
const partyBalanceService = require('../../../services/partyBalance.service');
const ledgerPosting      = require('../../../services/ledgerPosting.service');
const auditService       = require('../../../services/audit.service');
const taxEngine          = require('../../../services/taxEngine.service');
const goodsReceiptService = require('../../../services/goodsReceipt.service');
const invoiceService     = require('../../../services/invoice.service');

// ── Mocked persistence boundary ──────────────────────────────────────────────
const reportCache        = require('../../../utils/reportCache');
const customerRepository = require('../../../repositories/customer.repository');
const vendorRepository   = require('../../../repositories/vendor.repository');
const accountRepository  = require('../../../repositories/account.repository');
const auditLogRepository = require('../../../repositories/auditLog.repository');
const JournalEntry       = require('../../../models/JournalEntry.model');
const ChartOfAccount     = require('../../../models/ChartOfAccount.model');
const inventoryService   = require('../../../services/inventory.service');
const { getProfile }     = require('../../../config/countryTaxProfiles');

const BIZ_A = '507f1f77bcf86cd799439001';
const BIZ_B = '507f1f77bcf86cd799439002';
const USER  = { _id: '507f1f77bcf86cd799439010' };

/** Let the event engine's detached fire-and-forget handler chain settle. */
const flush = () => new Promise((r) => setImmediate(r));

beforeAll(() => {
  // Register the real Step-7 subscribers ONCE on the shared engine.
  eventSubscribers.registerAll();
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
//  GROUP A — Event-driven AR/AP ↔ analytics cache (Steps 4 + 7)
// ════════════════════════════════════════════════════════════════════════════
describe('Scenario 1 — AP recognition propagates: vendor balance + event + cache', () => {
  it('increments the vendor payable AND invalidates the analytics cache', async () => {
    vendorRepository.updatePayableBalance.mockResolvedValue({ _id: 'v1', currentPayableBalance: 1000 });

    await partyBalanceService.adjustPayable(BIZ_A, 'v1', 1000, { reason: 'bill_approved' });
    await flush();

    expect(vendorRepository.updatePayableBalance).toHaveBeenCalledWith('v1', 1000);   // AP module
    expect(reportCache.invalidate).toHaveBeenCalledWith(BIZ_A);                        // analytics module
  });
});

describe('Scenario 2 — AR recognition propagates: customer balance + event + cache', () => {
  it('increments the customer receivable AND invalidates the analytics cache', async () => {
    customerRepository.updateReceivableBalance.mockResolvedValue({ _id: 'c1', currentReceivableBalance: 500 });

    await partyBalanceService.adjustReceivable(BIZ_A, 'c1', 500, { reason: 'invoice_approved' });
    await flush();

    expect(customerRepository.updateReceivableBalance).toHaveBeenCalledWith('c1', 500);
    expect(reportCache.invalidate).toHaveBeenCalledWith(BIZ_A);
  });
});

describe('Scenario 3 — Settlement propagates: balance decrement + event + cache', () => {
  it('decrements the vendor payable on payment and refreshes analytics', async () => {
    vendorRepository.updatePayableBalance.mockResolvedValue({ _id: 'v1', currentPayableBalance: 0 });

    await partyBalanceService.adjustPayable(BIZ_A, 'v1', -1000, { reason: 'bill_paid' });
    await flush();

    expect(vendorRepository.updatePayableBalance).toHaveBeenCalledWith('v1', -1000);
    expect(reportCache.invalidate).toHaveBeenCalledWith(BIZ_A);
  });
});

describe('Scenario 4 — Tenant isolation: a tenant event never touches another tenant', () => {
  it('only invalidates the emitting business cache', async () => {
    customerRepository.updateReceivableBalance.mockResolvedValue({ _id: 'cB', currentReceivableBalance: 50 });

    await partyBalanceService.adjustReceivable(BIZ_B, 'cB', 50, {});
    await flush();

    expect(reportCache.invalidate).toHaveBeenCalledWith(BIZ_B);
    expect(reportCache.invalidate).not.toHaveBeenCalledWith(BIZ_A);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  GROUP B — Balanced ledger posting (Step 4)
// ════════════════════════════════════════════════════════════════════════════
describe('Scenario 5 — Balanced journal posts AND moves both running balances', () => {
  it('creates the JE and updates debit + credit accounts with the right signs', async () => {
    JournalEntry.create.mockImplementation((doc) => Promise.resolve({ _id: 'je1', ...doc }));
    accountRepository.findById.mockImplementation((id) =>
      Promise.resolve({ _id: id, normalBalance: id === 'AR' ? 'Debit' : 'Credit' })
    );
    accountRepository.updateRunningBalance.mockResolvedValue(undefined);

    const je = await ledgerPosting.postBalancedJournal({
      businessId: BIZ_A, amount: 1000, debitAccountId: 'AR', creditAccountId: 'SALES',
    });

    expect(je._id).toBe('je1');
    expect(accountRepository.updateRunningBalance).toHaveBeenCalledWith('AR', 1000);   // DR debit-normal +
    expect(accountRepository.updateRunningBalance).toHaveBeenCalledWith('SALES', 1000); // CR credit-normal +
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  GROUP C — Procurement → inventory (Step 5)
// ════════════════════════════════════════════════════════════════════════════
describe('Scenario 6 — GRN confirm receives goods into inventory + emits + cache', () => {
  it('adds accepted qty (received − rejected) per line and broadcasts GOODS_RECEIVED', async () => {
    const grn = {
      _id: 'grn1', businessId: BIZ_A, grnNumber: 'GRN-1', vendorId: 'v1',
      inventoryApplied: false,
      receivedItems: [
        { inventoryItemId: 'item1', name: 'Widget', quantityReceived: 10, quantityRejected: 2, unitCost: 500 },
        { name: 'Service line (untracked)', quantityReceived: 1, unitCost: 100 }, // no inventoryItemId → skip
      ],
      save: jest.fn().mockResolvedValue(undefined),
    };

    await goodsReceiptService._applyReceivedStock(grn, USER);
    await flush();

    expect(inventoryService.applyPurchaseStock).toHaveBeenCalledTimes(1);
    expect(inventoryService.applyPurchaseStock).toHaveBeenCalledWith(
      BIZ_A, 'item1', 8 /* 10 − 2 */, 500, expect.objectContaining({ userId: USER._id })
    );
    expect(grn.inventoryApplied).toBe(true);
    expect(reportCache.invalidate).toHaveBeenCalledWith(BIZ_A); // GOODS_RECEIVED → analytics
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  GROUP D — Sales → COGS + inventory (Step 5)
// ════════════════════════════════════════════════════════════════════════════
describe('Scenario 7 — Invoice approval recognizes COGS across inventory + ledger', () => {
  it('reduces stock per product line and posts one consolidated COGS journal', async () => {
    inventoryService.reduceStock
      .mockResolvedValueOnce({ cogsAmount: 300 })
      .mockResolvedValueOnce({ cogsAmount: 80 });
    inventoryService.resolveCostAccounts.mockResolvedValue({ cogsAccountId: 'COGS', inventoryAccountId: 'INV' });
    JournalEntry.create.mockImplementation((doc) => Promise.resolve({ _id: 'jeCogs', ...doc }));
    accountRepository.findById.mockResolvedValue({ _id: 'x', normalBalance: 'Debit' });
    accountRepository.updateRunningBalance.mockResolvedValue(undefined);

    const invoice = {
      businessId: BIZ_A, invoiceNumber: 'INV-1', issueDate: new Date(), currencyCode: 'PKR',
      lineItems: [
        { inventoryItemId: 'i1', quantity: 3 },
        { inventoryItemId: 'i2', quantity: 2 },
        { quantity: 9 }, // service line → no stock move
      ],
    };

    const total = await invoiceService._applyCogsForInvoice(invoice, USER);

    expect(inventoryService.reduceStock).toHaveBeenCalledTimes(2);
    expect(total).toBe(380);
    const cogsJe = JournalEntry.create.mock.calls.find((c) => c[0].debitAccountId === 'COGS');
    expect(cogsJe).toBeTruthy();
    expect(cogsJe[0].creditAccountId).toBe('INV');
    expect(cogsJe[0].amount).toBe(380);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  GROUP E — Tax engine seeding (Step 6 — the critical fix)
// ════════════════════════════════════════════════════════════════════════════
describe('Scenario 8 — Enabling tax seeds the control accounts onto ChartOfAccount', () => {
  it('creates the missing tax accounts (proves the ChartOfAccount model fix)', async () => {
    const pkAccounts = (getProfile('PK').additionalAccounts || []);
    ChartOfAccount.findOne.mockResolvedValue(null);   // none exist yet
    ChartOfAccount.create.mockResolvedValue({});

    const res = await taxEngine.ensureTaxAccounts(BIZ_A, 'PK');

    expect(res.created).toBe(pkAccounts.length);
    expect(res.created).toBeGreaterThan(0);
    expect(ChartOfAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BIZ_A, runningBalance: 0 })
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  GROUP F — Unified cross-module audit trail (Step 9)
// ════════════════════════════════════════════════════════════════════════════
describe('Scenario 9 — Activity timeline merges audit log + live events', () => {
  it('interleaves durable audit rows with engine event history, newest-first', async () => {
    const now = Date.now();
    auditLogRepository.getByBusiness.mockResolvedValue({
      data: [{ timestamp: new Date(now - 1000), action: 'state_changed', entityType: 'invoice',
               entityId: 'inv1', performedByName: 'Alice', afterState: { state: 'approved' } }],
    });
    jest.spyOn(businessEvents, 'getHistory').mockReturnValue([
      { occurredAt: new Date(now), eventName: 'customer.balance_changed', entityType: 'customer', entityId: 'c1' },
    ]);

    const res = await auditService.getActivityTimeline(BIZ_A, { limit: 10 });

    expect(res.auditCount).toBe(1);
    expect(res.eventCount).toBe(1);
    expect(res.items[0].source).toBe('event');     // newest first
    expect(res.items[1].source).toBe('audit');
    businessEvents.getHistory.mockRestore();
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  GROUP G — Core invariant: business isolation (Steps 2 + 10)
// ════════════════════════════════════════════════════════════════════════════
describe('Scenario 10 — The event engine refuses an event with no businessId', () => {
  it('throws on a missing tenant (guards cross-tenant leakage) but succeeds with one', () => {
    expect(() => businessEvents.emit(EVENTS.TRANSACTION_CREATED, { entityId: 'x' }))
      .toThrow(/businessId is required/i);

    const id = businessEvents.emit(EVENTS.TRANSACTION_CREATED, { businessId: BIZ_A, entityId: 'x' });
    expect(typeof id).toBe('string');
  });
});

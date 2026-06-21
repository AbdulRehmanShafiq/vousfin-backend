/**
 * tests/unit/services/partyBalance.service.test.js
 *
 * ERP Integration Refactor — Step 4 (AP/AR ↔ Customer/Vendor).
 * Validates the centralized party-balance engine: the receivable/payable
 * mutation is delegated to the repository $inc, a *_BALANCE_CHANGED event is
 * broadcast with the post-write balance, and no-op guards (missing id, zero
 * delta, deleted party) short-circuit cleanly without an event.
 *
 * Repositories are mocked. The REAL businessEventEngine is used with a spy on
 * emit() so we assert exactly which events fire without running detached handlers.
 */
'use strict';

jest.mock('../../../repositories/customer.repository', () => ({ updateReceivableBalance: jest.fn() }));
jest.mock('../../../repositories/vendor.repository',   () => ({ updatePayableBalance:    jest.fn() }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const partyBalanceService = require('../../../services/partyBalance.service');
const customerRepository  = require('../../../repositories/customer.repository');
const vendorRepository    = require('../../../repositories/vendor.repository');
const { businessEvents, EVENTS } = require('../../../services/businessEventEngine.service');

const ID_BUSINESS = '507f1f77bcf86cd799439060';
const ID_CUSTOMER = '507f1f77bcf86cd799439071';
const ID_VENDOR   = '507f1f77bcf86cd799439072';

const emittedNames   = () => businessEvents.emit.mock.calls.map((c) => c[0]);
const lastPayloadFor = (name) => {
  const call = [...businessEvents.emit.mock.calls].reverse().find((c) => c[0] === name);
  return call ? call[1] : undefined;
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(businessEvents, 'emit').mockReturnValue('evt-test-id');
});
afterEach(() => jest.restoreAllMocks());

// ── adjustReceivable ─────────────────────────────────────────────────────────
describe('PartyBalanceService.adjustReceivable()', () => {
  it('increments the receivable and broadcasts CUSTOMER_BALANCE_CHANGED with the new balance', async () => {
    customerRepository.updateReceivableBalance.mockResolvedValue({ _id: ID_CUSTOMER, currentReceivableBalance: 1500 });

    const res = await partyBalanceService.adjustReceivable(ID_BUSINESS, ID_CUSTOMER, 1000, {
      userId: 'u1', reason: 'credit_sale', entityType: 'journal_entry', entityId: 'tx9',
    });

    expect(customerRepository.updateReceivableBalance).toHaveBeenCalledWith(ID_CUSTOMER, 1000, null);
    expect(res.currentReceivableBalance).toBe(1500);

    expect(emittedNames()).toContain(EVENTS.CUSTOMER_BALANCE_CHANGED);
    const payload = lastPayloadFor(EVENTS.CUSTOMER_BALANCE_CHANGED);
    expect(payload.businessId).toBe(ID_BUSINESS);
    expect(payload.customerId).toBe(ID_CUSTOMER);
    expect(payload.delta).toBe(1000);
    expect(payload.newBalance).toBe(1500);
    expect(payload.reason).toBe('credit_sale');
  });

  it('rounds the delta to 2dp before writing', async () => {
    customerRepository.updateReceivableBalance.mockResolvedValue({ _id: ID_CUSTOMER, currentReceivableBalance: 10 });
    await partyBalanceService.adjustReceivable(ID_BUSINESS, ID_CUSTOMER, 33.333, {});
    expect(customerRepository.updateReceivableBalance).toHaveBeenCalledWith(ID_CUSTOMER, 33.33, null);
  });

  it('is a no-op (no repo call, no event) when delta is 0', async () => {
    const res = await partyBalanceService.adjustReceivable(ID_BUSINESS, ID_CUSTOMER, 0, {});
    expect(res).toBeNull();
    expect(customerRepository.updateReceivableBalance).not.toHaveBeenCalled();
    expect(emittedNames()).not.toContain(EVENTS.CUSTOMER_BALANCE_CHANGED);
  });

  it('is a no-op when no customerId is supplied', async () => {
    const res = await partyBalanceService.adjustReceivable(ID_BUSINESS, null, 500, {});
    expect(res).toBeNull();
    expect(customerRepository.updateReceivableBalance).not.toHaveBeenCalled();
  });

  it('throws ApiError(404) when the customer is gone at write time (repo returns null)', async () => {
    customerRepository.updateReceivableBalance.mockResolvedValue(null);
    await expect(
      partyBalanceService.adjustReceivable(ID_BUSINESS, ID_CUSTOMER, 500, { reason: 'invoice_approved' })
    ).rejects.toThrow(/customer/i);
    expect(emittedNames()).not.toContain(EVENTS.CUSTOMER_BALANCE_CHANGED);
  });

  it('accepts a populated customer sub-doc and normalizes its _id', async () => {
    customerRepository.updateReceivableBalance.mockResolvedValue({ _id: ID_CUSTOMER, currentReceivableBalance: 5 });
    await partyBalanceService.adjustReceivable(ID_BUSINESS, { _id: ID_CUSTOMER }, -250, {});
    expect(customerRepository.updateReceivableBalance).toHaveBeenCalledWith(ID_CUSTOMER, -250, null);
  });
});

// ── adjustPayable ──────────────────────────────────────────────────────────────
describe('PartyBalanceService.adjustPayable()', () => {
  it('increments the payable and broadcasts VENDOR_BALANCE_CHANGED with the new balance', async () => {
    vendorRepository.updatePayableBalance.mockResolvedValue({ _id: ID_VENDOR, currentPayableBalance: 800 });

    const res = await partyBalanceService.adjustPayable(ID_BUSINESS, ID_VENDOR, 800, {
      userId: 'u1', reason: 'bill_approved', entityType: 'bill', entityId: 'b3',
    });

    expect(vendorRepository.updatePayableBalance).toHaveBeenCalledWith(ID_VENDOR, 800, null);
    expect(res.currentPayableBalance).toBe(800);

    expect(emittedNames()).toContain(EVENTS.VENDOR_BALANCE_CHANGED);
    const payload = lastPayloadFor(EVENTS.VENDOR_BALANCE_CHANGED);
    expect(payload.businessId).toBe(ID_BUSINESS);
    expect(payload.vendorId).toBe(ID_VENDOR);
    expect(payload.delta).toBe(800);
    expect(payload.newBalance).toBe(800);
    expect(payload.reason).toBe('bill_approved');
  });

  it('decrements on a negative delta (settlement) and broadcasts', async () => {
    vendorRepository.updatePayableBalance.mockResolvedValue({ _id: ID_VENDOR, currentPayableBalance: 0 });
    await partyBalanceService.adjustPayable(ID_BUSINESS, ID_VENDOR, -800, { reason: 'bill_paid' });
    expect(vendorRepository.updatePayableBalance).toHaveBeenCalledWith(ID_VENDOR, -800, null);
    const payload = lastPayloadFor(EVENTS.VENDOR_BALANCE_CHANGED);
    expect(payload.newBalance).toBe(0);
    expect(payload.reason).toBe('bill_paid');
  });

  it('is a no-op when no vendorId is supplied', async () => {
    const res = await partyBalanceService.adjustPayable(ID_BUSINESS, undefined, 500, {});
    expect(res).toBeNull();
    expect(vendorRepository.updatePayableBalance).not.toHaveBeenCalled();
  });

  it('throws ApiError(404) when the vendor is gone at write time (repo returns null)', async () => {
    vendorRepository.updatePayableBalance.mockResolvedValue(null);
    await expect(
      partyBalanceService.adjustPayable(ID_BUSINESS, ID_VENDOR, 250, { reason: 'bill_approved' })
    ).rejects.toThrow(/vendor/i);
    expect(emittedNames()).not.toContain(EVENTS.VENDOR_BALANCE_CHANGED);
  });
});

// ── zero-delta no-op (audit Phase 1.4 brief spec) ────────────────────────────
describe('adjustReceivable zero-delta no-op (brief spec)', () => {
  it('returns null without calling the repo for a zero delta', async () => {
    const r = await partyBalanceService.adjustReceivable('b1', 'cust1', 0, {});
    expect(r).toBeNull();
    expect(customerRepository.updateReceivableBalance).not.toHaveBeenCalled();
  });
});

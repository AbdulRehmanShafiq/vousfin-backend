/**
 * tests/unit/utils/arApValidation.test.js
 *
 * AR/AP Domain Refactor — Milestone M4 (validation).
 * Exercises the shared service-layer validation: every control in the matrix.
 */
'use strict';

const {
  validateDocumentData, assertNoDuplicateNumber, assertPartyExists,
} = require('../../../utils/arApValidation');

const BIZ = '507f1f77bcf86cd799439060';
const base = { businessId: BIZ, invoiceNumber: 'INV-1', issueDate: new Date('2026-01-01'), amount: 1000 };
const expect400 = (fn) => expect(fn).toThrow(expect.objectContaining({ statusCode: 400 }));

describe('validateDocumentData — required identity (create)', () => {
  it('passes a minimal valid create', () => {
    expect(() => validateDocumentData({ ...base }, { kind: 'invoice' })).not.toThrow();
  });
  it('rejects missing document number', () => {
    expect400(() => validateDocumentData({ ...base, invoiceNumber: '' }, { kind: 'invoice' }));
  });
  it('rejects missing issueDate', () => {
    expect400(() => validateDocumentData({ ...base, issueDate: undefined }, { kind: 'invoice' }));
  });
  it('rejects zero amount with no line items', () => {
    expect400(() => validateDocumentData({ ...base, amount: 0 }, { kind: 'invoice' }));
  });
  it('allows update without identity fields', () => {
    expect(() => validateDocumentData({ amount: 50 }, { kind: 'invoice', isUpdate: true })).not.toThrow();
  });
});

describe('validateDocumentData — negative amounts', () => {
  it.each([['amount', -1], ['taxAmount', -1], ['shippingCharges', -1], ['invoiceDiscountValue', -1], ['whtAmount', -1]])(
    'rejects negative %s', (field, val) => {
      expect400(() => validateDocumentData({ ...base, [field]: val }, { kind: 'invoice', isUpdate: true }));
    }
  );
});

describe('validateDocumentData — currency + FX', () => {
  it('accepts a 3-letter ISO code', () => {
    expect(() => validateDocumentData({ ...base, currencyCode: 'USD' }, { kind: 'invoice' })).not.toThrow();
  });
  it('rejects a malformed currency', () => {
    expect400(() => validateDocumentData({ ...base, currencyCode: 'US' }, { kind: 'invoice' }));
    expect400(() => validateDocumentData({ ...base, currencyCode: 'DOLLAR' }, { kind: 'invoice' }));
  });
  it('rejects a non-positive exchange rate', () => {
    expect400(() => validateDocumentData({ ...base, exchangeRate: 0 }, { kind: 'invoice' }));
  });
});

describe('validateDocumentData — due date', () => {
  it('rejects dueDate earlier than issueDate', () => {
    expect400(() => validateDocumentData({ ...base, dueDate: new Date('2025-12-01') }, { kind: 'invoice' }));
  });
  it('accepts dueDate on/after issueDate', () => {
    expect(() => validateDocumentData({ ...base, dueDate: new Date('2026-02-01') }, { kind: 'invoice' })).not.toThrow();
  });
});

describe('validateDocumentData — line items', () => {
  const withLine = (li) => ({ businessId: BIZ, invoiceNumber: 'INV-1', issueDate: new Date(), lineItems: [li] });
  it('accepts a valid line', () => {
    expect(() => validateDocumentData(withLine({ name: 'Widget', quantity: 2, unitPrice: 10 }), { kind: 'invoice' })).not.toThrow();
  });
  it('rejects a line with no name', () => expect400(() => validateDocumentData(withLine({ name: '', quantity: 1, unitPrice: 1 }), { kind: 'invoice' })));
  it('rejects quantity <= 0', () => expect400(() => validateDocumentData(withLine({ name: 'X', quantity: 0, unitPrice: 1 }), { kind: 'invoice' })));
  it('rejects negative unit price', () => expect400(() => validateDocumentData(withLine({ name: 'X', quantity: 1, unitPrice: -5 }), { kind: 'invoice' })));
  it('rejects tax rate outside 0–100', () => expect400(() => validateDocumentData(withLine({ name: 'X', quantity: 1, unitPrice: 1, taxRate: 101 }), { kind: 'invoice' })));
});

describe('assertNoDuplicateNumber', () => {
  it('throws 409 when a document with the number exists', async () => {
    const Model = { findOne: jest.fn().mockResolvedValue({ _id: 'dup' }) };
    await expect(assertNoDuplicateNumber(Model, BIZ, 'INV-1', 'invoiceNumber'))
      .rejects.toMatchObject({ statusCode: 409 });
  });
  it('passes when none exists', async () => {
    const Model = { findOne: jest.fn().mockResolvedValue(null) };
    await expect(assertNoDuplicateNumber(Model, BIZ, 'INV-1', 'invoiceNumber')).resolves.toBeUndefined();
  });
  it('excludes self on update', async () => {
    const Model = { findOne: jest.fn().mockResolvedValue(null) };
    await assertNoDuplicateNumber(Model, BIZ, 'INV-1', 'invoiceNumber', 'self-id');
    expect(Model.findOne).toHaveBeenCalledWith(expect.objectContaining({ _id: { $ne: 'self-id' } }));
  });
});

describe('assertPartyExists', () => {
  it('throws 400 when the party is missing', async () => {
    const repo = { findByBusinessAndId: jest.fn().mockResolvedValue(null) };
    await expect(assertPartyExists(repo, BIZ, 'cust1', 'Customer')).rejects.toMatchObject({ statusCode: 400 });
  });
  it('passes when the party exists', async () => {
    const repo = { findByBusinessAndId: jest.fn().mockResolvedValue({ _id: 'cust1' }) };
    await expect(assertPartyExists(repo, BIZ, 'cust1', 'Customer')).resolves.toBeUndefined();
  });
  it('is a no-op when no party id is given', async () => {
    const repo = { findByBusinessAndId: jest.fn() };
    await assertPartyExists(repo, BIZ, null, 'Customer');
    expect(repo.findByBusinessAndId).not.toHaveBeenCalled();
  });
});

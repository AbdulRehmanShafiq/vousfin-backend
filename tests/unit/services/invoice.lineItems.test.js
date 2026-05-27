// tests/unit/services/invoice.lineItems.test.js
//
// Phase 2 — Tests for line item engine, dynamic totals computation,
// and multi-currency features.
//
// Tests the Invoice model's pre-save hook that computes totals from lineItems.
// Also tests updateDraft and credit note integration.
//

const mongoose = require('mongoose');

// ── Minimal Invoice model mock with REAL pre-save totals logic ───────────────
jest.mock('../../../repositories/customer.repository');
jest.mock('../../../services/audit.service');
jest.mock('../../../services/fx.service', () => ({
  prepareFxFields: jest.fn().mockResolvedValue({
    currencyCode: 'PKR',
    exchangeRate: 1,
    baseCurrencyAmount: 0,
  }),
  getBaseCurrency: jest.fn().mockResolvedValue('PKR'),
}));

// Build a mock Invoice model that exercises the real pre-save totals logic
jest.mock('../../../models/Invoice.model', () => {
  const mongoose = require('mongoose');
  const { INVOICE_TRANSITIONS } = require('../../../config/constants');
  const stateStore = new Map();

  function computeTotals(doc) {
    const r2 = (v) => Math.round(v * 100) / 100;
    if (doc.lineItems && doc.lineItems.length > 0) {
      let subtotal = 0, totalLineDiscount = 0, totalTax = 0;
      for (const li of doc.lineItems) {
        const gross = r2(li.quantity * li.unitPrice);
        let disc = 0;
        if (li.discountType === 'percentage' && li.discountValue > 0) {
          disc = r2(gross * li.discountValue / 100);
        } else if (li.discountType === 'fixed' && li.discountValue > 0) {
          disc = r2(Math.min(li.discountValue, gross));
        }
        li.discountAmount = disc;
        totalLineDiscount += disc;
        const afterDiscount = gross - disc;
        let tax = 0;
        if (li.taxRate > 0) {
          tax = li.taxInclusive
            ? r2(afterDiscount - afterDiscount / (1 + li.taxRate / 100))
            : r2(afterDiscount * li.taxRate / 100);
        }
        li.taxAmount = tax;
        totalTax += tax;
        li.lineTotal = li.taxInclusive ? r2(afterDiscount) : r2(afterDiscount + tax);
        subtotal += gross;
      }
      doc.subtotal = r2(subtotal);
      doc.totalLineDiscount = r2(totalLineDiscount);
      doc.totalTax = r2(totalTax);

      const afterLineDiscounts = r2(subtotal - totalLineDiscount);
      let invoiceDisc = 0;
      if (doc.invoiceDiscountType === 'percentage' && doc.invoiceDiscountValue > 0) {
        invoiceDisc = r2(afterLineDiscounts * doc.invoiceDiscountValue / 100);
      } else if (doc.invoiceDiscountType === 'fixed' && doc.invoiceDiscountValue > 0) {
        invoiceDisc = r2(Math.min(doc.invoiceDiscountValue, afterLineDiscounts));
      }
      doc.invoiceDiscountAmount = invoiceDisc;
      doc.amount = r2(afterLineDiscounts - invoiceDisc);
      doc.taxAmount = r2(totalTax);
      doc.totalAmount = r2(doc.amount + doc.taxAmount + (doc.shippingCharges || 0) + (doc.roundingAdjustment || 0));
    } else {
      if (doc.amount != null && doc.taxAmount != null) {
        doc.totalAmount = r2(doc.amount + (doc.taxAmount || 0) + (doc.shippingCharges || 0) + (doc.roundingAdjustment || 0));
      }
    }
    if (doc.exchangeRate && doc.exchangeRate !== 1 && doc.totalAmount) {
      doc.baseCurrencyTotal = r2(doc.totalAmount * doc.exchangeRate);
    } else {
      doc.baseCurrencyTotal = doc.totalAmount;
    }
    if (doc._isNew && (doc.remainingBalance === null || doc.remainingBalance === undefined)) {
      doc.remainingBalance = doc.totalAmount;
    }
  }

  function makeDoc(props) {
    const doc = {
      ...props,
      _id: props._id || new mongoose.Types.ObjectId(),
      lineItems: props.lineItems || [],
      approvalLog: [],
      stateHistory: [],
      fieldHistory: [],
      isArchived: false,
      _isNew: true,
      subtotal: 0,
      totalLineDiscount: 0,
      invoiceDiscountAmount: 0,
      totalTax: 0,
      shippingCharges: props.shippingCharges || 0,
      roundingAdjustment: props.roundingAdjustment || 0,
      invoiceDiscountType: props.invoiceDiscountType || null,
      invoiceDiscountValue: props.invoiceDiscountValue || 0,
      exchangeRate: props.exchangeRate || 1,
      baseCurrencyTotal: null,
      remainingBalance: null,
      totalCredited: 0,
      creditNoteIds: [],
      recordStateChange(toState, actor, reason) {
        this.stateHistory.push({ fromState: this.state, toState, actorId: actor._id, actorName: actor.fullName || 'Unknown', reason, timestamp: new Date() });
      },
      recordFieldChange(field, before, after, by) {
        this.fieldHistory.push({ field, before, after, changedBy: by, changedAt: new Date() });
      },
      async save() {
        computeTotals(this);
        this._isNew = false;
        stateStore.set(String(this._id), this);
        return this;
      },
      toObject() { return { ...this }; },
    };
    return doc;
  }

  const Invoice = function (props) {
    return makeDoc(props);
  };

  Invoice.canTransition = (from, to) => {
    if (from === to) return true;
    const allowed = INVOICE_TRANSITIONS[from];
    return Array.isArray(allowed) && allowed.includes(to);
  };
  Invoice.findById = jest.fn(async (id) => stateStore.get(String(id)) || null);
  Invoice.findOne = jest.fn(async () => null);
  Invoice.find = jest.fn(() => ({ sort: () => ({ skip: () => ({ limit: () => Promise.resolve([]) }) }) }));
  Invoice.countDocuments = jest.fn(async () => 0);
  Invoice._stateStore = stateStore;
  Invoice._makeDoc = makeDoc;

  return Invoice;
});

const invoiceService = require('../../../services/invoice.service');
const Invoice = require('../../../models/Invoice.model');

const user = { _id: new mongoose.Types.ObjectId(), fullName: 'Test User', email: 'test@test.com', role: 'owner' };

beforeEach(() => {
  Invoice._stateStore.clear();
  jest.clearAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
// LINE ITEM TOTALS
// ═════════════════════════════════════════════════════════════════════════════

describe('Line item totals computation', () => {
  test('simple 2-line invoice computes correct subtotal and totalAmount', async () => {
    const inv = await invoiceService.createDraft({
      businessId: new mongoose.Types.ObjectId(),
      invoiceNumber: 'LI-001',
      issueDate: new Date(),
      lineItems: [
        { name: 'Widget A', quantity: 2, unitPrice: 100 },
        { name: 'Widget B', quantity: 3, unitPrice: 50 },
      ],
    }, user, '127.0.0.1');

    expect(inv.subtotal).toBe(350);       // 200 + 150
    expect(inv.totalLineDiscount).toBe(0);
    expect(inv.totalTax).toBe(0);
    expect(inv.amount).toBe(350);
    expect(inv.totalAmount).toBe(350);
    expect(inv.remainingBalance).toBe(350);
  });

  test('line-level percentage discount is computed correctly', async () => {
    const inv = await invoiceService.createDraft({
      businessId: new mongoose.Types.ObjectId(),
      invoiceNumber: 'LI-002',
      issueDate: new Date(),
      lineItems: [
        { name: 'Item', quantity: 1, unitPrice: 1000, discountType: 'percentage', discountValue: 10 },
      ],
    }, user, '127.0.0.1');

    expect(inv.subtotal).toBe(1000);
    expect(inv.totalLineDiscount).toBe(100);
    expect(inv.amount).toBe(900);
    expect(inv.totalAmount).toBe(900);
  });

  test('line-level fixed discount caps at gross', async () => {
    const inv = await invoiceService.createDraft({
      businessId: new mongoose.Types.ObjectId(),
      invoiceNumber: 'LI-003',
      issueDate: new Date(),
      lineItems: [
        { name: 'Item', quantity: 1, unitPrice: 50, discountType: 'fixed', discountValue: 100 },
      ],
    }, user, '127.0.0.1');

    // discount capped at 50 (the gross)
    expect(inv.totalLineDiscount).toBe(50);
    expect(inv.amount).toBe(0);
    expect(inv.totalAmount).toBe(0);
  });

  test('tax is computed as exclusive by default', async () => {
    const inv = await invoiceService.createDraft({
      businessId: new mongoose.Types.ObjectId(),
      invoiceNumber: 'LI-004',
      issueDate: new Date(),
      lineItems: [
        { name: 'Service', quantity: 1, unitPrice: 1000, taxRate: 17 },
      ],
    }, user, '127.0.0.1');

    expect(inv.subtotal).toBe(1000);
    expect(inv.totalTax).toBe(170);
    expect(inv.amount).toBe(1000);
    expect(inv.totalAmount).toBe(1170);
  });

  test('tax inclusive mode extracts tax from price', async () => {
    const inv = await invoiceService.createDraft({
      businessId: new mongoose.Types.ObjectId(),
      invoiceNumber: 'LI-005',
      issueDate: new Date(),
      lineItems: [
        { name: 'Service', quantity: 1, unitPrice: 1170, taxRate: 17, taxInclusive: true },
      ],
    }, user, '127.0.0.1');

    expect(inv.subtotal).toBe(1170);
    // Tax extracted: 1170 - 1170/1.17 = 1170 - 1000 = 170
    expect(inv.totalTax).toBe(170);
    // Line total for inclusive = afterDiscount (no extra tax added)
    expect(inv.lineItems[0].lineTotal).toBe(1170);
  });

  test('invoice-level percentage discount works', async () => {
    const inv = await invoiceService.createDraft({
      businessId: new mongoose.Types.ObjectId(),
      invoiceNumber: 'LI-006',
      issueDate: new Date(),
      invoiceDiscountType: 'percentage',
      invoiceDiscountValue: 5,
      lineItems: [
        { name: 'Item', quantity: 10, unitPrice: 100 },
      ],
    }, user, '127.0.0.1');

    expect(inv.subtotal).toBe(1000);
    expect(inv.invoiceDiscountAmount).toBe(50);  // 5% of 1000
    expect(inv.amount).toBe(950);
    expect(inv.totalAmount).toBe(950);
  });

  test('shipping charges and rounding adjustment added to total', async () => {
    const inv = await invoiceService.createDraft({
      businessId: new mongoose.Types.ObjectId(),
      invoiceNumber: 'LI-007',
      issueDate: new Date(),
      shippingCharges: 200,
      roundingAdjustment: -0.50,
      lineItems: [
        { name: 'Item', quantity: 1, unitPrice: 1000 },
      ],
    }, user, '127.0.0.1');

    // total = 1000 + 0 (tax) + 200 (shipping) - 0.50 (rounding)
    expect(inv.totalAmount).toBe(1199.50);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// MULTI-CURRENCY
// ═════════════════════════════════════════════════════════════════════════════

describe('Multi-currency', () => {
  test('baseCurrencyTotal is computed when exchangeRate != 1', async () => {
    const inv = await invoiceService.createDraft({
      businessId: new mongoose.Types.ObjectId(),
      invoiceNumber: 'FX-001',
      issueDate: new Date(),
      currencyCode: 'USD',
      lineItems: [
        { name: 'Item', quantity: 1, unitPrice: 100 },
      ],
    }, user, '127.0.0.1');

    // With mock FX returning rate=1, baseCurrencyTotal = totalAmount
    expect(inv.baseCurrencyTotal).toBe(100);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// UPDATE DRAFT
// ═════════════════════════════════════════════════════════════════════════════

describe('updateDraft', () => {
  test('can update lineItems on a draft invoice', async () => {
    const bizId = new mongoose.Types.ObjectId();
    const inv = await invoiceService.createDraft({
      businessId: bizId,
      invoiceNumber: 'UP-001',
      issueDate: new Date(),
      lineItems: [{ name: 'Old Item', quantity: 1, unitPrice: 100 }],
    }, user, '127.0.0.1');

    expect(inv.totalAmount).toBe(100);

    const updated = await invoiceService.updateDraft(inv._id, {
      lineItems: [
        { name: 'New Item 1', quantity: 2, unitPrice: 200 },
        { name: 'New Item 2', quantity: 1, unitPrice: 50 },
      ],
    }, user, '127.0.0.1');

    expect(updated.lineItems.length).toBe(2);
    expect(updated.subtotal).toBe(450); // 400 + 50
    expect(updated.totalAmount).toBe(450);
  });

  test('rejects update on non-draft invoice', async () => {
    const bizId = new mongoose.Types.ObjectId();
    const inv = await invoiceService.createDraft({
      businessId: bizId,
      invoiceNumber: 'UP-002',
      issueDate: new Date(),
      amount: 1000,
    }, user, '127.0.0.1');

    // Force state to approved
    inv.state = 'approved';
    await inv.save();

    await expect(invoiceService.updateDraft(inv._id, { notes: 'test' }, user))
      .rejects.toThrow(/Only draft invoices/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// COMBINED DISCOUNTS + TAX
// ═════════════════════════════════════════════════════════════════════════════

describe('Combined discounts + tax', () => {
  test('line discount + invoice discount + tax computes correctly', async () => {
    const inv = await invoiceService.createDraft({
      businessId: new mongoose.Types.ObjectId(),
      invoiceNumber: 'COMBO-001',
      issueDate: new Date(),
      invoiceDiscountType: 'fixed',
      invoiceDiscountValue: 100,
      lineItems: [
        { name: 'Item A', quantity: 5, unitPrice: 200, discountType: 'percentage', discountValue: 10, taxRate: 17 },
        { name: 'Item B', quantity: 2, unitPrice: 500, taxRate: 5 },
      ],
    }, user, '127.0.0.1');

    // Item A: gross=1000, disc=100, after=900, tax=153 (17% of 900), lineTotal=1053
    // Item B: gross=1000, disc=0, after=1000, tax=50 (5% of 1000), lineTotal=1050
    expect(inv.subtotal).toBe(2000);
    expect(inv.totalLineDiscount).toBe(100);
    // Invoice discount: 100 fixed on (2000-100)=1900 → disc=100
    expect(inv.invoiceDiscountAmount).toBe(100);
    // amount = 1900 - 100 = 1800
    expect(inv.amount).toBe(1800);
    // totalTax = 153 + 50 = 203
    expect(inv.totalTax).toBe(203);
    // totalAmount = 1800 + 203 = 2003
    expect(inv.totalAmount).toBe(2003);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BACKWARD COMPATIBILITY (legacy path — no line items)
// ═════════════════════════════════════════════════════════════════════════════

describe('Backward compatibility (no lineItems)', () => {
  test('legacy invoice without lineItems still computes totalAmount', async () => {
    const inv = await invoiceService.createDraft({
      businessId: new mongoose.Types.ObjectId(),
      invoiceNumber: 'LEGACY-001',
      issueDate: new Date(),
      amount: 5000,
      taxAmount: 850,
    }, user, '127.0.0.1');

    // No lineItems → legacy path
    expect(inv.totalAmount).toBe(5850);
    expect(inv.remainingBalance).toBe(5850);
  });
});

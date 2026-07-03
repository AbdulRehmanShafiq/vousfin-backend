/**
 * tests/unit/services/creditApplication.openItemSync.test.js
 *
 * Audit 2026-07-02 F3 — wiring: applying (or cancelling) a credit note, and
 * applying a vendor credit to a bill, must adjust the OPEN-ITEM balance on the
 * linked recognition journal entry via openItemService.adjustOpenItem, inside
 * the same transaction session. Otherwise the payment engine (which validates
 * against the JE), the aging report and the VE-5 subledger reconcile all keep
 * seeing the un-credited balance.
 */
'use strict';

const mongoose = require('mongoose');

// ── Shared GL/txn mocks ──────────────────────────────────────────────────────
jest.mock('../../../services/audit.service', () => ({
  log: jest.fn(), logCreate: jest.fn(),
}));
jest.mock('../../../models/ChartOfAccount.model', () => ({
  findOne: jest.fn(() => ({
    lean: () => Promise.resolve({ _id: new (require('mongoose').Types.ObjectId)() }),
  })),
}));
jest.mock('../../../services/ledgerPosting.service', () => ({
  postBalancedJournal: jest.fn().mockResolvedValue({ _id: 'je-gl' }),
}));
jest.mock('../../../services/partyBalance.service', () => ({
  adjustReceivable: jest.fn().mockResolvedValue({}),
  adjustPayable: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../../utils/withTransaction', () => ({
  withTransaction: (fn) => fn('SESSION'),
}));
jest.mock('../../../services/transaction.service', () => ({
  reverseTransaction: jest.fn().mockResolvedValue({ _id: 'rev-je' }),
}));
jest.mock('../../../services/openItem.service', () => ({
  adjustOpenItem: jest.fn().mockResolvedValue({ _id: 'jeAR' }),
}));
jest.mock('../../../repositories/customer.repository', () => ({
  findByBusinessAndId: jest.fn().mockResolvedValue({ fullName: 'C', email: 'c@x' }),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

// ── CreditNote / Invoice model mocks (cloned from creditNote.service.test.js) ─
global.__oisCnStore = new Map();
global.__oisInvStore = new Map();

jest.mock('../../../models/CreditNote.model', () => {
  const mongoose = require('mongoose');
  function makeDoc(props) {
    return {
      ...props,
      _id: props._id || new mongoose.Types.ObjectId(),
      isArchived: false,
      async save() { global.__oisCnStore.set(String(this._id), this); return this; },
      toObject() { return { ...this }; },
    };
  }
  const CreditNote = function (props) { return makeDoc(props); };
  CreditNote.findById = jest.fn(async (id) => global.__oisCnStore.get(String(id)) || null);
  CreditNote.findOne = jest.fn(async (q) => (q?._id ? global.__oisCnStore.get(String(q._id)) || null : null));
  return CreditNote;
});
jest.mock('../../../models/Invoice.model', () => ({
  findOne: jest.fn(async (q) => (q?._id ? global.__oisInvStore.get(String(q._id)) || null : null)),
  findById: jest.fn((id) => {
    const doc = global.__oisInvStore.get(String(id)) || null;
    return {
      then: (res, rej) => Promise.resolve(doc).then(res, rej),
      session: () => Promise.resolve(doc),
    };
  }),
}));

// ── Bill / VendorCredit model mocks (cloned from vendorCredit.service.test.js) ─
jest.mock('../../../models/Bill.model', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/VendorCredit.model', () => {
  const mongoose = require('mongoose');
  const store = new Map();
  const { VENDOR_CREDIT_STATES } = require('../../../config/constants');
  function makeDoc(props) {
    return {
      ...props,
      _id: props._id || new mongoose.Types.ObjectId(),
      appliedTransactions: props.appliedTransactions || [],
      remainingAmount: props.remainingAmount ?? props.amount ?? 0,
      state: props.state || VENDOR_CREDIT_STATES.OPEN,
      isArchived: false,
      async save() {
        const applied = this.appliedTransactions.reduce((s, a) => s + a.appliedAmount, 0);
        this.remainingAmount = Math.max(0, Math.round((this.amount - applied) * 100) / 100);
        store.set(String(this._id), this);
        return this;
      },
      toObject() { return { ...this }; },
    };
  }
  const makeQ = (r) => ({ then: (res, rej) => Promise.resolve(r).then(res, rej), lean: () => Promise.resolve(r) });
  function VendorCredit(props) { return makeDoc(props); }
  VendorCredit.findById = (id) => makeQ(store.get(String(id)) || null);
  VendorCredit.findOne = () => makeQ(null);
  VendorCredit.__store = store;
  VendorCredit.__make = makeDoc;
  return VendorCredit;
});

const creditNoteService = require('../../../services/creditNote.service');
const vcService = require('../../../services/vendorCredit.service');
const VendorCredit = require('../../../models/VendorCredit.model');
const Bill = require('../../../models/Bill.model');
const openItemService = require('../../../services/openItem.service');

const USER = { _id: new mongoose.Types.ObjectId(), fullName: 'T', email: 't@x', businessId: null };
const BIZ = 'biz1';

beforeEach(() => {
  jest.clearAllMocks();
  global.__oisCnStore.clear();
  global.__oisInvStore.clear();
});

function seedInvoice(overrides = {}) {
  const id = new mongoose.Types.ObjectId();
  const invoice = {
    _id: id,
    businessId: BIZ,
    invoiceNumber: 'INV-1',
    totalAmount: 1000,
    remainingBalance: 1000,
    totalCredited: 0,
    customerId: new mongoose.Types.ObjectId(),
    linkedJournalEntryId: 'jeAR',
    creditNoteIds: [],
    lastModifiedBy: null,
    async save() { global.__oisInvStore.set(String(this._id), this); return this; },
    ...overrides,
  };
  global.__oisInvStore.set(String(id), invoice);
  return invoice;
}

function seedCreditNote(invoice, overrides = {}) {
  const CreditNote = require('../../../models/CreditNote.model');
  const cn = new CreditNote({
    businessId: BIZ,
    invoiceId: invoice._id,
    invoiceNumber: invoice.invoiceNumber,
    creditNoteNumber: 'CN-1',
    noteType: 'credit_note',
    totalAmount: 400,
    state: 'approved',
    ...overrides,
  });
  global.__oisCnStore.set(String(cn._id), cn);
  return cn;
}

describe('creditNote.apply — recognition-JE open item stays in sync', () => {
  test('applying a credit note reduces the invoice JE open balance in the same session', async () => {
    const invoice = seedInvoice();
    const cn = seedCreditNote(invoice);

    await creditNoteService.apply(String(cn._id), USER, '127.0.0.1');

    expect(openItemService.adjustOpenItem).toHaveBeenCalledWith(
      BIZ, 'jeAR', -400, expect.objectContaining({ session: 'SESSION' })
    );
  });

  test('cancelling an APPLIED credit note restores the invoice JE open balance', async () => {
    const invoice = seedInvoice({ remainingBalance: 600, totalCredited: 400 });
    const cn = seedCreditNote(invoice, { state: 'applied', linkedJournalEntryId: 'je-cn-gl' });

    await creditNoteService.cancel(String(cn._id), USER, 'mistake', '127.0.0.1');

    expect(openItemService.adjustOpenItem).toHaveBeenCalledWith(
      BIZ, 'jeAR', 400, expect.objectContaining({ session: 'SESSION' })
    );
  });
});

describe('creditNote.apply — FOREIGN credit notes convert to base (F2 residual)', () => {
  test('a USD 400 credit @280 books 112,000 base against GL, party and open item', async () => {
    const { postBalancedJournal } = require('../../../services/ledgerPosting.service');
    const partyBalanceService = require('../../../services/partyBalance.service');
    const invoice = seedInvoice({ currencyCode: 'USD', exchangeRate: 280, totalAmount: 1000, remainingBalance: 1000 });
    const cn = seedCreditNote(invoice, { currencyCode: 'USD', exchangeRate: 280 });

    await creditNoteService.apply(String(cn._id), USER, '127.0.0.1');

    expect(postBalancedJournal).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 112000, baseCurrencyAmount: 112000, currencyCode: 'USD', exchangeRate: 280 }),
      expect.any(Object)
    );
    expect(partyBalanceService.adjustReceivable).toHaveBeenCalledWith(
      cn.businessId, invoice.customerId, -112000, expect.any(Object)
    );
    expect(openItemService.adjustOpenItem).toHaveBeenCalledWith(
      BIZ, 'jeAR', -112000, expect.objectContaining({ session: 'SESSION' })
    );
  });
});

describe('vendorCredit.applyToBill — recognition-JE open item stays in sync', () => {
  test('applying a vendor credit reduces the bill JE open balance in the same session', async () => {
    const vc = VendorCredit.__make({
      businessId: BIZ, vendorId: 'vend1', creditNumber: 'VC-1',
      amount: 500, remainingAmount: 500,
    });
    VendorCredit.__store.set(String(vc._id), vc);
    const billId = new mongoose.Types.ObjectId();
    Bill.findOne.mockResolvedValue({
      _id: billId, businessId: BIZ, billNumber: 'BILL-1', state: 'approved',
      totalAmount: 2000, paidAmount: 0, remainingBalance: 2000,
      linkedJournalEntryId: 'jeAP',
      async save() { return this; },
    });

    await vcService.applyToBill(String(vc._id), String(billId), 500, USER, null, '127.0.0.1');

    expect(openItemService.adjustOpenItem).toHaveBeenCalledWith(
      BIZ, 'jeAP', -500, expect.objectContaining({ session: 'SESSION' })
    );
  });

  test('a FOREIGN vendor credit converts to base at the bill booking rate (F2 residual)', async () => {
    const { postBalancedJournal } = require('../../../services/ledgerPosting.service');
    const partyBalanceService = require('../../../services/partyBalance.service');
    const vc = VendorCredit.__make({
      businessId: BIZ, vendorId: 'vend1', creditNumber: 'VC-FX',
      amount: 500, remainingAmount: 500, currencyCode: 'USD', exchangeRate: 280,
    });
    VendorCredit.__store.set(String(vc._id), vc);
    const billId = new mongoose.Types.ObjectId();
    Bill.findOne.mockResolvedValue({
      _id: billId, businessId: BIZ, billNumber: 'BILL-FX', state: 'approved',
      totalAmount: 2000, paidAmount: 0, remainingBalance: 2000,
      currencyCode: 'USD', exchangeRate: 280,
      linkedJournalEntryId: 'jeAP',
      async save() { return this; },
    });

    await vcService.applyToBill(String(vc._id), String(billId), 400, USER, null, '127.0.0.1');

    // 400 USD × 280 = 112,000 base everywhere the ledger is touched.
    expect(postBalancedJournal).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 112000, baseCurrencyAmount: 112000 }),
      expect.any(Object)
    );
    expect(partyBalanceService.adjustPayable).toHaveBeenCalledWith(
      BIZ, 'vend1', -112000, expect.any(Object)
    );
    expect(openItemService.adjustOpenItem).toHaveBeenCalledWith(
      BIZ, 'jeAP', -112000, expect.objectContaining({ session: 'SESSION' })
    );
  });
});

// tests/unit/services/creditNote.service.test.js
//
// Phase 2 — Tests for credit note lifecycle: create, approve, apply, cancel.
//

const mongoose = require('mongoose');

// ── Mocks ────────────────────────────────────────────────────────────────────
jest.mock('../../../repositories/customer.repository', () => ({
  findByBusinessAndId: jest.fn().mockResolvedValue({ fullName: 'Test Customer', email: 'c@test.com' }),
}));
jest.mock('../../../services/audit.service', () => ({
  logCreate: jest.fn(),
  log: jest.fn(),
}));

// Use global to share stores between mock factories and tests
// (Jest mock factories cannot reference outer-scope variables)
global.__mockCnStore = new Map();
global.__mockInvoiceStoreForCN = new Map();

jest.mock('../../../models/CreditNote.model', () => {
  const mongoose = require('mongoose');

  function makeDoc(props) {
    const doc = {
      ...props,
      _id: props._id || new mongoose.Types.ObjectId(),
      isArchived: false,
      async save() {
        const r2 = (v) => Math.round(v * 100) / 100;
        if (this.lineItems && this.lineItems.length > 0) {
          let sub = 0, tax = 0;
          for (const li of this.lineItems) {
            const gross = r2(li.quantity * li.unitPrice);
            const t = li.taxRate > 0 ? r2(gross * li.taxRate / 100) : 0;
            li.taxAmount = t;
            li.lineTotal = r2(gross + t);
            sub += gross;
            tax += t;
          }
          this.subtotal = r2(sub);
          this.taxAmount = r2(tax);
          this.totalAmount = r2(sub + tax);
        }
        global.__mockCnStore.set(String(this._id), this);
        return this;
      },
      toObject() { return { ...this }; },
    };
    return doc;
  }

  const CreditNote = function (props) { return makeDoc(props); };
  CreditNote.findById = jest.fn(async (id) => global.__mockCnStore.get(String(id)) || null);
  CreditNote.findOne = jest.fn(async (q) => {
    if (q?._id) return global.__mockCnStore.get(String(q._id)) || null;
    return null;
  });
  CreditNote.find = jest.fn(() => ({ sort: () => Promise.resolve([]) }));
  CreditNote.countDocuments = jest.fn(async () => 0);
  return CreditNote;
});

jest.mock('../../../models/Invoice.model', () => {
  const Invoice = {
    findOne: jest.fn(async (q) => {
      if (q?._id) return global.__mockInvoiceStoreForCN.get(String(q._id)) || null;
      return null;
    }),
    // Returns a chainable thenable so callers can do either:
    //   await Invoice.findById(id)            (direct await)
    //   await Invoice.findById(id).session(s) (chained .session())
    findById: jest.fn((id) => {
      const doc = global.__mockInvoiceStoreForCN.get(String(id)) || null;
      const thenable = {
        then(onFulfilled, onRejected) { return Promise.resolve(doc).then(onFulfilled, onRejected); },
        catch(onRejected) { return Promise.resolve(doc).catch(onRejected); },
        session(_s) { return Promise.resolve(doc); },
      };
      return thenable;
    }),
  };
  return Invoice;
});

// GL deps for apply() — credit notes now post atomically (audit A9), so the test
// must provide the accounts, poster, party-balance service and txn wrapper.
jest.mock('../../../models/ChartOfAccount.model', () => ({
  findOne: jest.fn(() => ({
    lean: () => Promise.resolve({ _id: new (require('mongoose').Types.ObjectId)() }),
  })),
}));
jest.mock('../../../services/ledgerPosting.service', () => ({
  postBalancedJournal: jest.fn().mockResolvedValue({ _id: 'je-cn' }),
}));
jest.mock('../../../services/partyBalance.service', () => ({
  adjustReceivable: jest.fn().mockResolvedValue({}),
  adjustPayable:    jest.fn().mockResolvedValue({}),
}));
jest.mock('../../../utils/withTransaction', () => ({
  withTransaction: (fn) => fn(null), // run the unit without a real session
}));
jest.mock('../../../services/transaction.service', () => ({
  reverseTransaction: jest.fn().mockResolvedValue({ _id: 'rev-je' }),
}));

const creditNoteService = require('../../../services/creditNote.service');
const { postBalancedJournal } = require('../../../services/ledgerPosting.service');

const user = { _id: new mongoose.Types.ObjectId(), fullName: 'Tester', email: 'test@test.com', role: 'owner' };

beforeEach(() => {
  global.__mockCnStore.clear();
  global.__mockInvoiceStoreForCN.clear();
  jest.clearAllMocks();
});

function seedInvoice(overrides = {}) {
  const id = new mongoose.Types.ObjectId();
  const inv = {
    _id: id,
    businessId: overrides.businessId || new mongoose.Types.ObjectId(),
    invoiceNumber: overrides.invoiceNumber || 'INV-TEST',
    totalAmount: overrides.totalAmount || 10000,
    totalCredited: overrides.totalCredited || 0,
    remainingBalance: overrides.remainingBalance ?? overrides.totalAmount ?? 10000,
    customerId: overrides.customerId || null,
    currencyCode: 'PKR',
    baseCurrencyCode: 'PKR',
    exchangeRate: 1,
    creditNoteIds: [],
    lastModifiedBy: null,
    async save() { global.__mockInvoiceStoreForCN.set(String(this._id), this); return this; },
    ...overrides,
  };
  global.__mockInvoiceStoreForCN.set(String(id), inv);
  return inv;
}

// ═════════════════════════════════════════════════════════════════════════════

describe('CreditNote — create', () => {
  test('creates a draft credit note linked to an invoice', async () => {
    const inv = seedInvoice({ totalAmount: 5000 });
    const cn = await creditNoteService.create({
      businessId: inv.businessId,
      invoiceId: inv._id,
      creditNoteNumber: 'CN-001',
      issueDate: new Date(),
      totalAmount: 1000,
    }, user, '127.0.0.1');

    expect(cn.state).toBe('draft');
    expect(cn.invoiceId.toString()).toBe(inv._id.toString());
    expect(cn.creditNoteNumber).toBe('CN-001');
  });

  test('rejects credit that exceeds creditable balance', async () => {
    const inv = seedInvoice({ totalAmount: 1000, totalCredited: 800 });
    await expect(
      creditNoteService.create({
        businessId: inv.businessId,
        invoiceId: inv._id,
        creditNoteNumber: 'CN-OVER',
        issueDate: new Date(),
        totalAmount: 500, // only 200 creditable
      }, user, '127.0.0.1')
    ).rejects.toThrow(/exceeds remaining creditable/);
  });

  test('creates credit note with line items', async () => {
    const inv = seedInvoice({ totalAmount: 10000 });
    const cn = await creditNoteService.create({
      businessId: inv.businessId,
      invoiceId: inv._id,
      creditNoteNumber: 'CN-LI',
      issueDate: new Date(),
      lineItems: [
        { name: 'Return Widget', quantity: 2, unitPrice: 100, taxRate: 17 },
      ],
    }, user, '127.0.0.1');

    expect(cn.subtotal).toBe(200);
    expect(cn.taxAmount).toBe(34);
    expect(cn.totalAmount).toBe(234);
  });
});

describe('CreditNote — approve + apply', () => {
  test('approve transitions draft → approved', async () => {
    const inv = seedInvoice({ totalAmount: 5000 });
    const cn = await creditNoteService.create({
      businessId: inv.businessId,
      invoiceId: inv._id,
      creditNoteNumber: 'CN-APP',
      issueDate: new Date(),
      totalAmount: 1000,
    }, user, '127.0.0.1');

    const approved = await creditNoteService.approve(cn._id, user);
    expect(approved.state).toBe('approved');
    expect(approved.approvedBy.toString()).toBe(user._id.toString());
  });

  test('apply reduces invoice remaining balance', async () => {
    const inv = seedInvoice({ totalAmount: 5000, remainingBalance: 5000 });
    const cn = await creditNoteService.create({
      businessId: inv.businessId,
      invoiceId: inv._id,
      creditNoteNumber: 'CN-APPLY',
      issueDate: new Date(),
      totalAmount: 1500,
    }, user, '127.0.0.1');

    await creditNoteService.approve(cn._id, user);
    await creditNoteService.apply(cn._id, user);

    const updatedInv = global.__mockInvoiceStoreForCN.get(String(inv._id));
    expect(updatedInv.totalCredited).toBe(1500);
    expect(updatedInv.remainingBalance).toBe(3500);
    expect(updatedInv.creditNoteIds.length).toBe(1);
  });

  test('apply re-checks the creditable limit — two notes cannot over-credit one invoice', async () => {
    // Both notes are created while totalCredited is still 0, so each passes the
    // create-time guard (600 <= 1000). totalCredited is only bumped at apply, so
    // without an apply-time re-check the second apply would over-credit the
    // invoice (total 1200 credited against a 1000 invoice) and drive the
    // customer receivable negative. The second apply MUST be rejected.
    const inv = seedInvoice({ totalAmount: 1000, remainingBalance: 1000, customerId: new mongoose.Types.ObjectId() });
    const mk = async (num) => {
      const cn = await creditNoteService.create({
        businessId: inv.businessId, invoiceId: inv._id,
        creditNoteNumber: num, issueDate: new Date(), totalAmount: 600,
      }, user, '127.0.0.1');
      await creditNoteService.approve(cn._id, user);
      return cn;
    };
    const cn1 = await mk('CN-A');
    const cn2 = await mk('CN-B');

    await creditNoteService.apply(cn1._id, user); // 600 of 1000 — ok
    await expect(creditNoteService.apply(cn2._id, user))
      .rejects.toMatchObject({ statusCode: 400 });

    const updatedInv = global.__mockInvoiceStoreForCN.get(String(inv._id));
    expect(updatedInv.totalCredited).toBe(600); // not 1200
  });

  test('apply posts the GL entry inside the transaction session (audit A9)', async () => {
    const inv = seedInvoice({ totalAmount: 5000, remainingBalance: 5000, customerId: new mongoose.Types.ObjectId() });
    const cn = await creditNoteService.create({
      businessId: inv.businessId, invoiceId: inv._id,
      creditNoteNumber: 'CN-ATOMIC', issueDate: new Date(), totalAmount: 1000,
    }, user, '127.0.0.1');
    await creditNoteService.approve(cn._id, user);
    const applied = await creditNoteService.apply(cn._id, user);

    expect(applied.state).toBe('applied');
    // The poster is invoked with the session arg from withTransaction (null here).
    expect(postBalancedJournal).toHaveBeenCalledWith(expect.any(Object), { session: null });
  });
});

describe('CreditNote — cancel', () => {
  test('cancelling an applied credit note reverses the credit', async () => {
    const inv = seedInvoice({ totalAmount: 5000, remainingBalance: 5000 });
    const cn = await creditNoteService.create({
      businessId: inv.businessId,
      invoiceId: inv._id,
      creditNoteNumber: 'CN-CANCEL',
      issueDate: new Date(),
      totalAmount: 2000,
    }, user, '127.0.0.1');

    await creditNoteService.approve(cn._id, user);
    await creditNoteService.apply(cn._id, user);

    // Verify applied
    let updatedInv = global.__mockInvoiceStoreForCN.get(String(inv._id));
    expect(updatedInv.remainingBalance).toBe(3000);

    // Cancel
    await creditNoteService.cancel(cn._id, user, 'Mistake');

    updatedInv = global.__mockInvoiceStoreForCN.get(String(inv._id));
    expect(updatedInv.totalCredited).toBe(0);
    expect(updatedInv.remainingBalance).toBe(5000);
    expect(updatedInv.creditNoteIds.length).toBe(0);
  });

  test('cancel rejects (does not swallow) when the GL reversal fails', async () => {
    const inv = seedInvoice({ totalAmount: 5000, remainingBalance: 5000 });
    const cn = await creditNoteService.create({
      businessId: inv.businessId,
      invoiceId: inv._id,
      creditNoteNumber: 'CN-CANCEL-ATOMIC',
      issueDate: new Date(),
      totalAmount: 500,
    }, user, '127.0.0.1');

    await creditNoteService.approve(cn._id, user);
    await creditNoteService.apply(cn._id, user);

    // Give the cn a linkedJournalEntryId so the reversal path is triggered
    cn.linkedJournalEntryId = 'je1';

    const transactionService = require('../../../services/transaction.service');
    jest.spyOn(transactionService, 'reverseTransaction').mockRejectedValue(new Error('GL down'));

    await expect(
      creditNoteService.cancel(cn._id, user, 'mistake', '0.0.0.0')
    ).rejects.toThrow('GL down');

    // The credit note must NOT have been flipped to cancelled when the reversal failed.
    expect(cn.state).not.toBe('cancelled');
  });
});

describe('CreditNote — debit note', () => {
  test('debit note increases remaining balance on apply', async () => {
    const inv = seedInvoice({ totalAmount: 5000, remainingBalance: 3000 });
    const cn = await creditNoteService.create({
      businessId: inv.businessId,
      invoiceId: inv._id,
      creditNoteNumber: 'DN-001',
      noteType: 'debit_note',
      issueDate: new Date(),
      totalAmount: 500,
    }, user, '127.0.0.1');

    await creditNoteService.approve(cn._id, user);
    await creditNoteService.apply(cn._id, user);

    const updatedInv = global.__mockInvoiceStoreForCN.get(String(inv._id));
    expect(updatedInv.remainingBalance).toBe(3500); // increased by 500
  });

  test('debit note posts a GL entry (DR AR / CR Sales) and raises the customer receivable', async () => {
    const partyBalance = require('../../../services/partyBalance.service');
    const customerId = new mongoose.Types.ObjectId();
    const inv = seedInvoice({ totalAmount: 5000, remainingBalance: 3000, customerId });
    const cn = await creditNoteService.create({
      businessId: inv.businessId, invoiceId: inv._id, creditNoteNumber: 'DN-002',
      noteType: 'debit_note', issueDate: new Date(), totalAmount: 500, customerId,
    }, user, '127.0.0.1');

    await creditNoteService.approve(cn._id, user);
    await creditNoteService.apply(cn._id, user);

    // A balanced JE must be posted for the debit note (was the F-gap: none before)
    expect(postBalancedJournal).toHaveBeenCalled();
    // Receivable goes UP by the base amount (a debit note charges the customer more)
    expect(partyBalance.adjustReceivable).toHaveBeenCalledWith(
      inv.businessId, customerId, 500,
      expect.objectContaining({ reason: 'debit_note_applied' })
    );
    const applied = global.__mockCnStore.get(String(cn._id));
    expect(applied.linkedJournalEntryId).toBeTruthy();
  });
});

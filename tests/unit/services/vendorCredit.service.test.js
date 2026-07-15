// tests/unit/services/vendorCredit.service.test.js
//
// Phase 3.1 — Unit tests for vendorCredit.service.js.
//
jest.mock('../../../services/audit.service');

// ── Bill model mock ──────────────────────────────────────────────────────────
jest.mock('../../../models/Bill.model', () => {
  const mongoose = require('mongoose');
  const billStore = new Map();

  function makeBill(props) {
    return {
      ...props,
      _id:           props._id || new mongoose.Types.ObjectId(),
      billNumber:    props.billNumber || 'BILL-001',
      paidAmount:    props.paidAmount || 0,
      remainingBalance: props.remainingBalance ?? props.totalAmount ?? 0,
      totalAmount:   props.totalAmount || 0,
      state:         props.state || 'approved',
      businessId:    props.businessId || 'biz1',
      lastModifiedBy: null,
      async save() { billStore.set(String(this._id), this); return this; },
    };
  }

  const Bill = { findOne: jest.fn(), __billStore: billStore, __makeBill: makeBill };
  return Bill;
});

// ── VendorCredit model mock ───────────────────────────────────────────────────
jest.mock('../../../models/VendorCredit.model', () => {
  const stateStore = new Map();
  const mongoose = require('mongoose');
  const { VENDOR_CREDIT_STATES } = require('../../../config/constants');

  function makeDoc(props) {
    const doc = {
      ...props,
      _id:                  props._id || new mongoose.Types.ObjectId(),
      amount:               props.amount || 0,
      remainingAmount:      props.remainingAmount ?? props.amount ?? 0,
      appliedTransactions:  props.appliedTransactions || [],
      state:                props.state || VENDOR_CREDIT_STATES.OPEN,
      isArchived:           !!props.isArchived,
      lastModifiedBy:       null,
      async save() {
        // Replicate pre-save hook: recompute remainingAmount + state
        const totalApplied = (this.appliedTransactions || []).reduce((s, a) => s + a.appliedAmount, 0);
        this.remainingAmount = Math.max(0, Math.round((this.amount - totalApplied) * 100) / 100);
        if (this.remainingAmount <= 0) {
          this.state = VENDOR_CREDIT_STATES.FULLY_APPLIED;
        } else if (totalApplied > 0) {
          if (this.state !== VENDOR_CREDIT_STATES.CANCELLED) {
            this.state = VENDOR_CREDIT_STATES.PARTIALLY_APPLIED;
          }
        }
        stateStore.set(String(this._id), this);
        return this;
      },
      toObject() { return { ...this }; },
    };
    return doc;
  }

  const makeQ = (result) => {
    const q = {
      sort:     () => q,
      lean:     () => Promise.resolve(result),
      populate: () => q,
      select:   () => q,
      then:     (res, rej) => Promise.resolve(result).then(res, rej),
    };
    return q;
  };

  function VendorCredit(props) { return makeDoc(props); }
  VendorCredit.findById = (id) => makeQ(stateStore.get(String(id)) || null);
  VendorCredit.findOne  = ()   => makeQ(null);
  VendorCredit.find     = ()   => makeQ(Array.from(stateStore.values()));
  VendorCredit.countDocuments = async () => stateStore.size;
  VendorCredit.__reset = () => stateStore.clear();
  return VendorCredit;
});

// GL deps for applyToBill() — vendor credits now post atomically (audit A9), so the
// application must resolve accounts, a poster, the party-balance service and a txn wrapper.
// Account lookups resolve to a stable id PER ACCOUNT CODE so the Phase 3 tests
// can assert which account each journal leg actually hit.
jest.mock('../../../models/ChartOfAccount.model', () => ({
  findOne: jest.fn((q) => {
    const code = typeof q?.accountCode === 'string'
      ? q.accountCode
      : (q?.accountCode?.$in ? q.accountCode.$in[0] : 'GENERIC');
    return { lean: () => Promise.resolve({ _id: `acct-${code}` }) };
  }),
}));
jest.mock('../../../services/ledgerPosting.service', () => ({
  postBalancedJournal: jest.fn().mockResolvedValue({ _id: 'je-vc' }),
}));
jest.mock('../../../services/partyBalance.service', () => ({
  adjustPayable:    jest.fn().mockResolvedValue({}),
  adjustReceivable: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../../utils/withTransaction', () => ({
  withTransaction: (fn) => fn(null),
}));
// Phase 3 (INV-2) — goods physically returning to the vendor.
jest.mock('../../../services/inventory.service', () => ({
  resolveCostAccounts: jest.fn().mockResolvedValue({ cogsAccountId: 'acct-5110', inventoryAccountId: 'acct-1150' }),
  reduceStock: jest.fn().mockResolvedValue({ cogsAmount: 0, unitCostUsed: 0 }),
  applyPurchaseStock: jest.fn().mockResolvedValue({ item: {} }),
}));
jest.mock('../../../services/transaction.service', () => ({
  reverseTransaction: jest.fn().mockResolvedValue({ _id: 'rev-je' }),
}));

const VendorCredit = require('../../../models/VendorCredit.model');
const Bill         = require('../../../models/Bill.model');
const vcService    = require('../../../services/vendorCredit.service');
const auditService = require('../../../services/audit.service');
const inventoryService = require('../../../services/inventory.service');
const transactionService = require('../../../services/transaction.service');
const { postBalancedJournal } = require('../../../services/ledgerPosting.service');

const USER = { _id: 'u1', fullName: 'Carol AP', email: 'carol@x', role: 'accountant' };
const BIZ  = 'biz1';

beforeEach(() => {
  jest.clearAllMocks();
  VendorCredit.__reset();
  auditService.log       = jest.fn().mockResolvedValue(undefined);
  auditService.logCreate = jest.fn().mockResolvedValue(undefined);
  auditService.logDelete = jest.fn().mockResolvedValue(undefined);
  auditService.logUpdate = jest.fn().mockResolvedValue(undefined);
  inventoryService.resolveCostAccounts.mockResolvedValue({ cogsAccountId: 'acct-5110', inventoryAccountId: 'acct-1150' });

  // Default bill mock: approved, Rs 5000 outstanding
  const mockBill = Bill.__makeBill({ totalAmount: 5000, state: 'approved', businessId: BIZ });
  Bill.__billStore.set(String(mockBill._id), mockBill);
  Bill.findOne.mockImplementation(async () => mockBill);
  Bill.__mockBill = mockBill;
});

// ─────────────────────────────────────────────────────────────────────────────
describe('vcService.create()', () => {
  const baseData = {
    businessId: BIZ,
    vendorId:   'v1',
    amount:     2000,
    creditDate: new Date(),
    reason:     'goods_returned',
  };

  test('creates a credit in OPEN state', async () => {
    const vc = await vcService.create(baseData, USER);
    expect(vc.state).toBe('open');
    expect(vc.remainingAmount).toBe(2000);
    expect(vc.amount).toBe(2000);
    expect(auditService.logCreate).toHaveBeenCalledTimes(1);
  });

  test('auto-numbers the credit', async () => {
    const vc = await vcService.create(baseData, USER);
    expect(vc.creditNumber).toMatch(/^VC-\d{6}-\d{5}$/);
  });

  test('throws 400 for amount <= 0', async () => {
    await expect(
      vcService.create({ ...baseData, amount: 0 }, USER)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  // ── Phase 3 (INV-2): goods physically returned to the vendor ──────────────
  // A money-only credit is unchanged; a credit WITH returnItems must take the
  // stock out and park the credit's value in Vendor Credit Clearing (1156)
  // until it is applied against a bill.
  describe('goods return (returnItems)', () => {
    const ITEM = 'item-A';
    const returnData = (over = {}) => ({
      ...baseData, amount: 2000,
      returnItems: [{ inventoryItemId: ITEM, quantity: 4 }],
      ...over,
    });

    test('money-only credit never touches stock (unchanged behavior)', async () => {
      const vc = await vcService.create(baseData, USER);
      expect(inventoryService.reduceStock).not.toHaveBeenCalled();
      expect(vc.inventoryJournalId).toBeUndefined();
      expect(postBalancedJournal).not.toHaveBeenCalled();
    });

    test('takes stock out at cost and posts DR 1156 clearing / CR 1150 inventory', async () => {
      // 4 units leaving at cost 400 total; vendor credits 2000 → 1600 above cost.
      inventoryService.reduceStock.mockResolvedValue({ cogsAmount: 400, unitCostUsed: 100 });
      const vc = await vcService.create(returnData(), USER);

      expect(inventoryService.reduceStock).toHaveBeenCalledWith(
        BIZ, ITEM, 4, null, expect.objectContaining({ movementType: 'purchase_return' })
      );
      expect(vc.returnItems[0].unitCostAtReturn).toBe(100); // remembered for cancel

      const [je] = postBalancedJournal.mock.calls[0];
      expect(je.amount).toBe(2000);
      const dr = je.journalLines.filter((l) => l.type === 'debit');
      const cr = je.journalLines.filter((l) => l.type === 'credit');
      expect(dr).toEqual([expect.objectContaining({ accountId: 'acct-1156', amount: 2000 })]);
      expect(cr).toEqual(expect.arrayContaining([
        expect.objectContaining({ accountId: 'acct-1150', amount: 400 }),   // inventory out at cost
        expect.objectContaining({ accountId: 'acct-4180', amount: 1600 }),  // credited above cost
      ]));
      // Balanced: 2000 DR == 400 + 1600 CR
      expect(dr.reduce((s, l) => s + l.amount, 0)).toBe(cr.reduce((s, l) => s + l.amount, 0));
      expect(vc.inventoryJournalId).toBe('je-vc');
    });

    test('credit below cost books the shortfall to Inventory Write-off (6495)', async () => {
      // 4 units leaving at cost 2500; vendor credits only 2000 → 500 loss.
      inventoryService.reduceStock.mockResolvedValue({ cogsAmount: 2500, unitCostUsed: 625 });
      await vcService.create(returnData(), USER);

      const [je] = postBalancedJournal.mock.calls[0];
      const dr = je.journalLines.filter((l) => l.type === 'debit');
      expect(dr).toEqual(expect.arrayContaining([
        expect.objectContaining({ accountId: 'acct-1156', amount: 2000 }),
        expect.objectContaining({ accountId: 'acct-6495', amount: 500 }),
      ]));
      expect(dr.reduce((s, l) => s + l.amount, 0)).toBe(2500); // == CR inventory 2500
    });

    test('applying a goods-return credit drains the clearing account, not income', async () => {
      inventoryService.reduceStock.mockResolvedValue({ cogsAmount: 400, unitCostUsed: 100 });
      const vc = await vcService.create(returnData(), USER);
      postBalancedJournal.mockClear();

      await vcService.applyToBill(vc._id, String(Bill.__mockBill._id), 1000, USER, null, '0.0.0.0');

      const [je] = postBalancedJournal.mock.calls[0];
      expect(je.debitAccountId).toBe('acct-2110');  // DR Accounts Payable
      expect(je.creditAccountId).toBe('acct-1156'); // CR clearing — value already booked at creation
    });

    test('applying a money-only credit still books income (legacy treatment kept)', async () => {
      const vc = await vcService.create(baseData, USER);
      await vcService.applyToBill(vc._id, String(Bill.__mockBill._id), 1000, USER, null, '0.0.0.0');

      const [je] = postBalancedJournal.mock.calls[0];
      expect(je.debitAccountId).toBe('acct-2110');
      expect(je.creditAccountId).toBe('acct-4180'); // Discount Received
    });

    test('cancelling a goods-return credit reverses the journal and restocks the goods', async () => {
      inventoryService.reduceStock.mockResolvedValue({ cogsAmount: 400, unitCostUsed: 100 });
      const vc = await vcService.create(returnData(), USER);

      await vcService.cancel(vc._id, USER, 'vendor refused the return', '0.0.0.0');

      expect(transactionService.reverseTransaction).toHaveBeenCalledWith(
        'je-vc', BIZ, expect.objectContaining({ reason: expect.stringMatching(/cancelled/i) }), USER._id, '0.0.0.0'
      );
      // Goods come back at the SAME cost they left with
      expect(inventoryService.applyPurchaseStock).toHaveBeenCalledWith(
        BIZ, ITEM, 4, 100, expect.objectContaining({ movementType: 'adjustment_in' })
      );
      expect(vc.state).toBe('cancelled');
      expect(vc.inventoryJournalId).toBeNull();
    });
  });

  test('throws 400 for missing required fields', async () => {
    await expect(
      vcService.create({ businessId: BIZ, vendorId: 'v1' }, USER)
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('vcService.applyToBill()', () => {
  async function makeCredit(amount) {
    return vcService.create({
      businessId: BIZ, vendorId: 'v1', amount, creditDate: new Date(), reason: 'price_adjustment',
    }, USER);
  }

  test('partial application reduces remainingAmount and sets PARTIALLY_APPLIED', async () => {
    const vc      = await makeCredit(3000);
    const billId  = Bill.__mockBill._id;
    const applied = await vcService.applyToBill(vc._id, billId, 1000, USER, 'partial', '127.0.0.1');
    expect(applied.remainingAmount).toBe(2000);
    expect(applied.state).toBe('partially_applied');
    expect(applied.appliedTransactions).toHaveLength(1);
    expect(applied.appliedTransactions[0].appliedAmount).toBe(1000);
  });

  test('full application transitions to FULLY_APPLIED', async () => {
    const vc     = await makeCredit(1500);
    const billId = Bill.__mockBill._id;
    const applied = await vcService.applyToBill(vc._id, billId, 1500, USER);
    expect(applied.state).toBe('fully_applied');
    expect(applied.remainingAmount).toBe(0);
  });

  test('throws 400 when applied amount exceeds remaining', async () => {
    const vc = await makeCredit(1000);
    await expect(
      vcService.applyToBill(vc._id, Bill.__mockBill._id, 1500, USER)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects applying more than the BILL owes (cannot over-pay / drive AP negative)', async () => {
    // Credit has 5000 available; the bill only owes 2000. The credit-side check
    // (amount <= remainingAmount) passes, but applying 5000 would push the bill's
    // paidAmount above its total and over-reduce Accounts Payable. Must reject.
    const smallBill = Bill.__makeBill({ totalAmount: 2000, remainingBalance: 2000, state: 'approved', businessId: BIZ });
    Bill.__billStore.set(String(smallBill._id), smallBill);
    Bill.findOne.mockResolvedValue(smallBill);
    const vc = await makeCredit(5000);
    await expect(
      vcService.applyToBill(vc._id, smallBill._id, 5000, USER)
    ).rejects.toMatchObject({ statusCode: 400 });
    // Bill untouched — no partial write before the guard.
    expect(smallBill.paidAmount).toBe(0);
  });

  test('throws 409 when credit is already fully applied', async () => {
    const vc = await makeCredit(500);
    await vcService.applyToBill(vc._id, Bill.__mockBill._id, 500, USER);
    await expect(
      vcService.applyToBill(vc._id, Bill.__mockBill._id, 100, USER)
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test('throws 409 when bill state is paid', async () => {
    const paidBill = Bill.__makeBill({ totalAmount: 5000, state: 'paid', businessId: BIZ });
    Bill.findOne.mockResolvedValueOnce(paidBill);
    const vc = await makeCredit(500);
    await expect(
      vcService.applyToBill(vc._id, paidBill._id, 500, USER)
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test('bill remainingBalance is reduced after application', async () => {
    const vc = await makeCredit(1000);
    await vcService.applyToBill(vc._id, Bill.__mockBill._id, 1000, USER);
    expect(Bill.__mockBill.remainingBalance).toBe(4000); // 5000 - 1000
    expect(Bill.__mockBill.paidAmount).toBe(1000);
  });

  test('posts the credit-application journal inside the transaction session (audit A9)', async () => {
    const vc = await makeCredit(1000);
    await vcService.applyToBill(vc._id, Bill.__mockBill._id, 1000, USER);
    // DR AP / CR credit posted through the poster with the txn session (null here).
    expect(postBalancedJournal).toHaveBeenCalledWith(expect.any(Object), { session: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('vcService.cancel()', () => {
  test('cancels an open credit with no applications', async () => {
    const vc = await vcService.create({
      businessId: BIZ, vendorId: 'v1', amount: 500, creditDate: new Date(), reason: 'overpayment',
    }, USER);
    const cancelled = await vcService.cancel(vc._id, USER, 'Error entry', '127.0.0.1');
    expect(cancelled.state).toBe('cancelled');
  });

  test('throws 409 when credit has partial applications', async () => {
    const vc = await vcService.create({
      businessId: BIZ, vendorId: 'v1', amount: 1000, creditDate: new Date(), reason: 'overpayment',
    }, USER);
    await vcService.applyToBill(vc._id, Bill.__mockBill._id, 500, USER);
    await expect(vcService.cancel(vc._id, USER, 'test')).rejects.toMatchObject({ statusCode: 409 });
  });

  test('throws 409 when credit is fully applied', async () => {
    const vc = await vcService.create({
      businessId: BIZ, vendorId: 'v1', amount: 500, creditDate: new Date(), reason: 'defective_goods',
    }, USER);
    await vcService.applyToBill(vc._id, Bill.__mockBill._id, 500, USER);
    await expect(vcService.cancel(vc._id, USER, 'test')).rejects.toMatchObject({ statusCode: 409 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('vcService.softDelete()', () => {
  test('archives an open credit', async () => {
    const vc = await vcService.create({
      businessId: BIZ, vendorId: 'v1', amount: 200, creditDate: new Date(), reason: 'other',
    }, USER);
    const archived = await vcService.softDelete(vc._id, USER, '127.0.0.1');
    expect(archived.isArchived).toBe(true);
    expect(archived.archivedAt).toBeTruthy();
  });
});

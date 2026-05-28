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

const VendorCredit = require('../../../models/VendorCredit.model');
const Bill         = require('../../../models/Bill.model');
const vcService    = require('../../../services/vendorCredit.service');
const auditService = require('../../../services/audit.service');

const USER = { _id: 'u1', fullName: 'Carol AP', email: 'carol@x', role: 'accountant' };
const BIZ  = 'biz1';

beforeEach(() => {
  jest.clearAllMocks();
  VendorCredit.__reset();
  auditService.log       = jest.fn().mockResolvedValue(undefined);
  auditService.logCreate = jest.fn().mockResolvedValue(undefined);
  auditService.logDelete = jest.fn().mockResolvedValue(undefined);

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

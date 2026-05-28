// tests/unit/services/purchaseOrder.service.test.js
//
// Phase 3.1 — Unit tests for purchaseOrder.service.js.
//
jest.mock('../../../repositories/vendor.repository');
jest.mock('../../../services/audit.service');
jest.mock('../../../models/PurchaseOrder.model', () => {
  const stateStore = new Map();
  const mongoose = require('mongoose');
  const { PO_TRANSITIONS } = require('../../../config/constants');

  function makeDoc(props) {
    const doc = {
      ...props,
      _id:          props._id          || new mongoose.Types.ObjectId(),
      approvalLog:  props.approvalLog  || [],
      stateHistory: props.stateHistory || [],
      lineItems:    props.lineItems    || [],
      linkedGrnIds: props.linkedGrnIds || [],
      linkedBillIds:props.linkedBillIds|| [],
      isArchived:   !!props.isArchived,
      totalAmount:  props.totalAmount  || 0,
      recordStateChange(toState, actor, reason) {
        this.stateHistory.push({
          fromState: this.state, toState,
          actorId: actor._id, actorName: actor.fullName || 'Unknown',
          reason: reason || null, timestamp: new Date(),
        });
      },
      async save() { stateStore.set(String(this._id), this); return this; },
      toObject() { return { ...this }; },
    };
    return doc;
  }

  // Chainable query mock — supports .sort().lean() and direct await
  const makeQ = (result) => {
    const q = {
      sort:     () => q,
      lean:     () => Promise.resolve(result),
      populate: () => q,
      then:     (res, rej) => Promise.resolve(result).then(res, rej),
    };
    return q;
  };

  function PurchaseOrder(props) { return makeDoc(props); }
  PurchaseOrder.canTransition = (from, to) => {
    if (from === to) return true;
    const allowed = PO_TRANSITIONS[from];
    return Array.isArray(allowed) && allowed.includes(to);
  };
  PurchaseOrder.findById = (id) => makeQ(stateStore.get(String(id)) || null);
  PurchaseOrder.findOne  = () => makeQ(null);
  PurchaseOrder.find     = () => makeQ(Array.from(stateStore.values()));
  PurchaseOrder.countDocuments = async () => stateStore.size;
  PurchaseOrder.__reset = () => stateStore.clear();
  return PurchaseOrder;
});

const PurchaseOrder = require('../../../models/PurchaseOrder.model');
const poService     = require('../../../services/purchaseOrder.service');
const auditService  = require('../../../services/audit.service');
const vendorRepository = require('../../../repositories/vendor.repository');

const USER = { _id: 'u1', fullName: 'Alice Procurement', email: 'alice@x', role: 'manager' };
const BIZ  = 'biz1';

beforeEach(() => {
  jest.clearAllMocks();
  PurchaseOrder.__reset();
  vendorRepository.findByBusinessAndId = jest.fn().mockResolvedValue({
    vendorName: 'Acme Supplies', email: 'acme@x', phone: '+92300', taxId: 'NTN-1',
  });
  auditService.log       = jest.fn().mockResolvedValue(undefined);
  auditService.logCreate = jest.fn().mockResolvedValue(undefined);
  auditService.logDelete = jest.fn().mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('poService.createDraft()', () => {
  const baseData = {
    businessId: BIZ,
    issueDate:  new Date(),
    vendorId:   'v1',
    lineItems:  [{ name: 'Widget A', quantityOrdered: 10, unitPrice: 500, taxRate: 0 }],
  };

  test('creates a draft in DRAFT state', async () => {
    const po = await poService.createDraft(baseData, USER, '127.0.0.1');
    expect(po.state).toBe('draft');
    expect(po.vendorSnapshot.vendorName).toBe('Acme Supplies');
    expect(auditService.logCreate).toHaveBeenCalledTimes(1);
  });

  test('auto-numbers PO when poNumber not supplied', async () => {
    const po = await poService.createDraft(baseData, USER);
    expect(po.poNumber).toMatch(/^PO-\d{6}-\d{5}$/);
  });

  test('uses supplied poNumber', async () => {
    const po = await poService.createDraft({ ...baseData, poNumber: 'PO-CUSTOM-001' }, USER);
    expect(po.poNumber).toBe('PO-CUSTOM-001');
  });

  test('throws 400 if lineItems empty', async () => {
    await expect(
      poService.createDraft({ ...baseData, lineItems: [] }, USER)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('throws 400 if issueDate missing', async () => {
    await expect(
      poService.createDraft({ businessId: BIZ, lineItems: baseData.lineItems }, USER)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('marks approvalRequired=true above threshold (default 50000)', async () => {
    // 300 × 200 = 60,000 — above the DEFAULT_APPROVAL_THRESHOLD of 50,000
    const bigLines = [{ name: 'Expensive', quantityOrdered: 300, unitPrice: 200, taxRate: 0 }];
    const po = await poService.createDraft({ ...baseData, lineItems: bigLines }, USER);
    expect(po.approvalRequired).toBe(true);
  });

  test('records initial state change in stateHistory', async () => {
    const po = await poService.createDraft(baseData, USER);
    expect(po.stateHistory).toHaveLength(1);
    expect(po.stateHistory[0].toState).toBe('draft');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('poService.submitForApproval()', () => {
  async function makeDraft(approvalRequired = false) {
    const po = await poService.createDraft(
      {
        businessId: BIZ,
        issueDate:  new Date(),
        vendorId:   'v1',
        lineItems:  [{ name: 'Widget', quantityOrdered: 1, unitPrice: 100, taxRate: 0 }],
      },
      USER
    );
    po.approvalRequired = approvalRequired;
    await po.save();
    return po;
  }

  test('auto-approves when approvalRequired=false', async () => {
    const po = await makeDraft(false);
    const updated = await poService.submitForApproval(po._id, USER, '127.0.0.1');
    expect(updated.state).toBe('approved');
  });

  test('moves to pending_approval when approval is required', async () => {
    const po = await makeDraft(true);
    const updated = await poService.submitForApproval(po._id, USER, '127.0.0.1');
    expect(updated.state).toBe('pending_approval');
    expect(updated.approvalLog).toHaveLength(1);
    expect(updated.approvalLog[0].action).toBe('submitted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('poService.approve() / reject()', () => {
  async function makePending() {
    const po = await poService.createDraft(
      { businessId: BIZ, issueDate: new Date(), vendorId: 'v1',
        lineItems: [{ name: 'X', quantityOrdered: 1, unitPrice: 100, taxRate: 0 }] },
      USER
    );
    po.state = 'pending_approval';
    po.approvalRequired = true;
    await po.save();
    return po;
  }

  test('approve moves to approved state', async () => {
    const po = await makePending();
    const approved = await poService.approve(po._id, USER, 'Looks good', '127.0.0.1');
    expect(approved.state).toBe('approved');
    expect(approved.approvedBy).toBe(USER._id);
    expect(approved.approvalLog.some(e => e.action === 'approved')).toBe(true);
  });

  test('reject returns to draft', async () => {
    const po = await makePending();
    const rejected = await poService.reject(po._id, USER, 'Budget exceeded', '127.0.0.1');
    expect(rejected.state).toBe('draft');
    expect(rejected.approvalLog.some(e => e.action === 'rejected')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('poService.cancel()', () => {
  test('cancels an approved PO', async () => {
    const po = await poService.createDraft(
      { businessId: BIZ, issueDate: new Date(),
        lineItems: [{ name: 'A', quantityOrdered: 1, unitPrice: 50, taxRate: 0 }] },
      USER
    );
    po.state = 'approved';
    await po.save();
    const cancelled = await poService.cancel(po._id, USER, 'Wrong vendor', '127.0.0.1');
    expect(cancelled.state).toBe('cancelled');
  });

  test('cannot cancel a closed PO', async () => {
    const po = await poService.createDraft(
      { businessId: BIZ, issueDate: new Date(),
        lineItems: [{ name: 'B', quantityOrdered: 1, unitPrice: 50, taxRate: 0 }] },
      USER
    );
    po.state = 'closed';
    await po.save();
    await expect(poService.cancel(po._id, USER, 'test')).rejects.toMatchObject({ statusCode: 409 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('poService.runThreeWayMatch()', () => {
  async function makeApprovedPO(totalAmount) {
    const po = await poService.createDraft(
      { businessId: BIZ, issueDate: new Date(),
        lineItems: [{ name: 'Item', quantityOrdered: 1, unitPrice: totalAmount, taxRate: 0 }] },
      USER
    );
    po.state = 'approved';
    po.totalAmount = totalAmount;
    await po.save();
    return po;
  }

  test('returns matched when bill is within 5% tolerance', async () => {
    const po = await makeApprovedPO(10000);
    const result = await poService.runThreeWayMatch(po._id, 9800, 10100);
    expect(result.status).toBe('matched');
  });

  test('returns discrepancy when bill exceeds 5% tolerance', async () => {
    const po = await makeApprovedPO(10000);
    const result = await poService.runThreeWayMatch(po._id, 9800, 11000);
    expect(result.status).toBe('discrepancy');
    expect(result.variance).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('poService._loadOrThrow()', () => {
  test('throws 400 for invalid id', async () => {
    await expect(poService.getById('not-an-objectid', BIZ)).rejects.toMatchObject({ statusCode: 400 });
  });
});

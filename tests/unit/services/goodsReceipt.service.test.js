// tests/unit/services/goodsReceipt.service.test.js
//
// Phase 3.1 — Unit tests for goodsReceipt.service.js.
//
jest.mock('../../../services/audit.service');
// A13 — stub transaction.service so cancel's reverseTransaction call is trackable.
jest.mock('../../../services/transaction.service', () => ({
  reverseTransaction: jest.fn().mockResolvedValue({ _id: 'rev1' }),
}));
jest.mock('../../../services/purchaseOrder.service', () => ({
  recordGrnReceipt: jest.fn().mockResolvedValue({}),
}));
// Phase 8 — confirm() reads each item's costing method to split out any
// purchase price variance. These items are plain weighted-average (no PPV).
jest.mock('../../../models/InventoryItem.model', () => ({
  findOne: jest.fn(() => ({
    select: () => ({ lean: () => Promise.resolve({ valuationMethod: 'weighted_average' }) }),
  })),
}));
// ERP Step 5 — stub the inventory engine so we can assert receive→stock wiring.
jest.mock('../../../services/inventory.service', () => ({
  applyPurchaseStock: jest.fn().mockResolvedValue({ item: {} }),
  reduceStock:        jest.fn().mockResolvedValue({ updatedStock: 0 }),
  applyReceiptReversal: jest.fn().mockResolvedValue({ item: {}, removedValue: 0 }),
  resolveCostAccounts: jest.fn(),
}));
// A13 — stub the ledger poster so we can assert the GRNI accrual entry.
jest.mock('../../../services/ledgerPosting.service', () => ({
  postCompoundJournal: jest.fn().mockResolvedValue({ _id: 'je-grn-1' }),
}));
// A13 — stub the account repo so _ensureAccount resolves the 1150/2115 accounts.
jest.mock('../../../repositories/account.repository', () => ({
  findByCode: jest.fn().mockImplementation((b, code) =>
    Promise.resolve({ _id: code === '1150' ? 'inv1' : 'grni1', accountCode: code })),
  syncMissingDefaults: jest.fn().mockResolvedValue(undefined),
}));
// A13 — run the transactional work synchronously with a truthy session so the
// post + subledger increment + guard-save all see a session (mongoose is not
// connected in unit tests, so the real withTransaction would pass null).
jest.mock('../../../utils/withTransaction', () => ({
  withTransaction: jest.fn((work) => work({ id: 'sess-1' })),
}));

jest.mock('../../../models/PurchaseOrder.model', () => {
  const mongoose = require('mongoose');
  const po = {
    _id:       new mongoose.Types.ObjectId(),
    state:     'approved',
    vendorId:  new mongoose.Types.ObjectId(),
    lineItems: [
      { _id: new mongoose.Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'), name: 'Widget', quantityOrdered: 10, unitPrice: 500, unit: 'pcs' },
      { _id: new mongoose.Types.ObjectId('bbbbbbbbbbbbbbbbbbbbbbbb'), name: 'Gadget', quantityOrdered: 5,  unitPrice: 200, unit: 'pcs' },
    ],
  };
  return {
    findOne:     jest.fn().mockResolvedValue(po),
    findById:    jest.fn().mockResolvedValue(po),
    __mockPO: po,
  };
});

jest.mock('../../../models/GoodsReceipt.model', () => {
  const stateStore = new Map();
  const mongoose   = require('mongoose');
  const { GRN_TRANSITIONS } = require('../../../config/constants');

  function makeDoc(props) {
    const doc = {
      ...props,
      _id:           props._id          || new mongoose.Types.ObjectId(),
      discrepancies: props.discrepancies || [],
      receivedItems: props.receivedItems || [],
      linkedBillIds: props.linkedBillIds || [],
      stateHistory:  props.stateHistory  || [],
      isArchived:    !!props.isArchived,
      recordStateChange(toState, actor, reason) {
        this.stateHistory.push({ fromState: this.state, toState, actorId: actor._id, reason, timestamp: new Date() });
      },
      async save() { stateStore.set(String(this._id), this); return this; },
      toObject() { return { ...this }; },
    };
    return doc;
  }

  const makeQ = (result) => {
    const q = {
      sort:     () => q,
      lean:     () => Promise.resolve(result),
      populate: () => q,
      then:     (res, rej) => Promise.resolve(result).then(res, rej),
    };
    return q;
  };

  function GoodsReceipt(props) { return makeDoc(props); }
  GoodsReceipt.canTransition = (from, to) => {
    if (from === to) return true;
    const allowed = GRN_TRANSITIONS[from];
    return Array.isArray(allowed) && allowed.includes(to);
  };
  GoodsReceipt.findById = (id) => makeQ(stateStore.get(String(id)) || null);
  GoodsReceipt.findOne  = ()   => makeQ(null);
  GoodsReceipt.find     = ()   => makeQ(Array.from(stateStore.values()));
  GoodsReceipt.countDocuments = async () => stateStore.size;
  GoodsReceipt.__reset = () => stateStore.clear();
  return GoodsReceipt;
});

const GoodsReceipt  = require('../../../models/GoodsReceipt.model');
const PurchaseOrder = require('../../../models/PurchaseOrder.model');
const grnService    = require('../../../services/goodsReceipt.service');
const auditService  = require('../../../services/audit.service');
const poService     = require('../../../services/purchaseOrder.service');
const inventoryService = require('../../../services/inventory.service');
const { postCompoundJournal } = require('../../../services/ledgerPosting.service');
const { businessEvents, EVENTS } = require('../../../services/businessEventEngine.service');
const transactionService = require('../../../services/transaction.service');

const USER = { _id: 'u1', fullName: 'Bob Warehouse', email: 'bob@x', role: 'warehouse' };
const BIZ  = 'biz1';

const PO_ID   = PurchaseOrder.__mockPO._id;
const LINE_1  = PurchaseOrder.__mockPO.lineItems[0]._id;
const LINE_2  = PurchaseOrder.__mockPO.lineItems[1]._id;

beforeEach(() => {
  jest.restoreAllMocks(); // undo any jest.spyOn() patches from the previous test
  jest.clearAllMocks();
  GoodsReceipt.__reset();
  auditService.log       = jest.fn().mockResolvedValue(undefined);
  auditService.logCreate = jest.fn().mockResolvedValue(undefined);
  auditService.logDelete = jest.fn().mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('grnService.createDraft()', () => {
  const baseData = {
    businessId:     BIZ,
    purchaseOrderId: PO_ID,
    receivedDate:   new Date(),
    receivedItems:  [
      { poLineItemId: LINE_1, name: 'Widget', quantityOrdered: 10, quantityReceived: 10, unitCost: 500 },
    ],
  };

  test('creates a GRN in DRAFT state linked to the PO', async () => {
    const grn = await grnService.createDraft(baseData, USER);
    expect(grn.state).toBe('draft');
    expect(String(grn.purchaseOrderId)).toBe(String(PO_ID));
    expect(grn.stateHistory).toHaveLength(1);
  });

  test('auto-generates grnNumber', async () => {
    const grn = await grnService.createDraft(baseData, USER);
    expect(grn.grnNumber).toMatch(/^GRN-\d{6}-\d{5}$/);
  });

  test('throws 400 when receivedItems is empty', async () => {
    await expect(
      grnService.createDraft({ ...baseData, receivedItems: [] }, USER)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('throws 404 when PO not found', async () => {
    PurchaseOrder.findOne.mockResolvedValueOnce(null);
    await expect(grnService.createDraft(baseData, USER)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('throws 409 when PO is not in a receivable state', async () => {
    PurchaseOrder.findOne.mockResolvedValueOnce({ ...PurchaseOrder.__mockPO, state: 'draft' });
    await expect(grnService.createDraft(baseData, USER)).rejects.toMatchObject({ statusCode: 409 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('grnService.confirm()', () => {
  async function makeDraftGRN(receivedItems) {
    return grnService.createDraft(
      { businessId: BIZ, purchaseOrderId: PO_ID, receivedDate: new Date(), receivedItems },
      USER
    );
  }

  test('confirms without discrepancy when quantities match', async () => {
    const grn = await makeDraftGRN([
      { poLineItemId: LINE_1, name: 'Widget', quantityOrdered: 10, quantityReceived: 10, unitCost: 500 },
    ]);
    const confirmed = await grnService.confirm(grn._id, USER, '127.0.0.1');
    expect(confirmed.state).toBe('confirmed');
    expect(confirmed.discrepancies).toHaveLength(0);
    expect(poService.recordGrnReceipt).toHaveBeenCalledTimes(1);
  });

  test('moves to discrepancy_reported when quantity short', async () => {
    const grn = await makeDraftGRN([
      { poLineItemId: LINE_1, name: 'Widget', quantityOrdered: 10, quantityReceived: 7, unitCost: 500 },
    ]);
    const confirmed = await grnService.confirm(grn._id, USER);
    expect(confirmed.state).toBe('discrepancy_reported');
    expect(confirmed.discrepancies.length).toBeGreaterThan(0);
    const d = confirmed.discrepancies[0];
    expect(d.type).toBe('quantity_short');
    expect(d.quantityExpected).toBe(10);
    expect(d.quantityActual).toBe(7);
  });

  test('detects price mismatch discrepancy (>5% deviation)', async () => {
    const grn = await makeDraftGRN([
      { poLineItemId: LINE_1, name: 'Widget', quantityOrdered: 10, quantityReceived: 10, unitCost: 600 }, // 500 → 600 = 20% over
    ]);
    const confirmed = await grnService.confirm(grn._id, USER);
    expect(confirmed.state).toBe('discrepancy_reported');
    expect(confirmed.discrepancies.some(d => d.type === 'price_mismatch')).toBe(true);
  });

  test('throws 409 when trying to confirm a non-draft GRN', async () => {
    const grn = await makeDraftGRN([
      { poLineItemId: LINE_1, name: 'Widget', quantityOrdered: 10, quantityReceived: 10, unitCost: 500 },
    ]);
    grn.state = 'confirmed';
    await grn.save();
    await expect(grnService.confirm(grn._id, USER)).rejects.toMatchObject({ statusCode: 409 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('grnService.cancel()', () => {
  test('cancels a draft GRN', async () => {
    const grn = await grnService.createDraft(
      { businessId: BIZ, purchaseOrderId: PO_ID, receivedDate: new Date(),
        receivedItems: [{ poLineItemId: LINE_1, name: 'W', quantityOrdered: 5, quantityReceived: 5, unitCost: 100 }] },
      USER
    );
    const cancelled = await grnService.cancel(grn._id, USER, 'Wrong PO', '127.0.0.1');
    expect(cancelled.state).toBe('cancelled');
  });

  test('cannot cancel a reconciled GRN', async () => {
    const grn = await grnService.createDraft(
      { businessId: BIZ, purchaseOrderId: PO_ID, receivedDate: new Date(),
        receivedItems: [{ poLineItemId: LINE_1, name: 'W', quantityOrdered: 5, quantityReceived: 5, unitCost: 100 }] },
      USER
    );
    grn.state = 'reconciled';
    await grn.save();
    await expect(grnService.cancel(grn._id, USER, 'test')).rejects.toMatchObject({ statusCode: 409 });
  });

  // A13 — cancelling a confirmed GRN with a posted GRNI accrual must reverse it.
  test('cancel reverses the GRNI journal when one was posted', async () => {
    const mongoose = require('mongoose');
    // Build a confirmed GRN with a GL journal already posted.
    const grn = await grnService.createDraft(
      { businessId: BIZ, purchaseOrderId: PO_ID, receivedDate: new Date(),
        receivedItems: [{ poLineItemId: LINE_1, name: 'W', quantityOrdered: 5, quantityReceived: 5, unitCost: 100 }] },
      USER
    );
    grn.state = 'confirmed';
    grn.glJournalId = new mongoose.Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa');
    grn.inventoryApplied = true;
    // Stub _loadOrThrow to bypass the findOne mock (which returns null for businessId-scoped queries)
    // Use jest.spyOn so it is automatically restored by jest.restoreAllMocks() / afterEach.
    jest.spyOn(grnService, '_loadOrThrow').mockResolvedValue(grn);

    const revSpy = jest.spyOn(transactionService, 'reverseTransaction');
    await grnService.cancel(grn._id, { _id: 'u1', businessId: BIZ }, 'wrong delivery', '0.0.0.0');

    expect(revSpy).toHaveBeenCalledWith(
      'aaaaaaaaaaaaaaaaaaaaaaaa',
      expect.anything(),
      expect.objectContaining({ reason: expect.stringContaining('cancelled') }),
      'u1',
      '0.0.0.0'
    );
    // glJournalId must be cleared after reversal
    expect(grn.glJournalId).toBeNull();
    // inventoryApplied must be cleared so the receipt nets to zero
    expect(grn.inventoryApplied).toBe(false);
  });

  // A13 (Finding 2) — multi-item GRN cancel must reverse stock for EACH stocked
  // line and call reverseTransaction with the session (atomicity check).
  test('cancel multi-item GRN reverses stock for every stocked line with the transaction session', async () => {
    const mongoose = require('mongoose');
    const ITEM_A = new mongoose.Types.ObjectId();
    const ITEM_B = new mongoose.Types.ObjectId();

    const grn = await grnService.createDraft(
      { businessId: BIZ, purchaseOrderId: PO_ID, receivedDate: new Date(),
        receivedItems: [
          { poLineItemId: LINE_1, inventoryItemId: ITEM_A, name: 'WidgetA', quantityOrdered: 3, quantityReceived: 3, quantityRejected: 0, unitCost: 100 },
          { poLineItemId: LINE_2, inventoryItemId: ITEM_B, name: 'WidgetB', quantityOrdered: 5, quantityReceived: 5, quantityRejected: 1, unitCost: 200 },
        ] },
      USER
    );
    grn.state = 'confirmed';
    grn.glJournalId = new mongoose.Types.ObjectId('cccccccccccccccccccccccc');
    grn.inventoryApplied = true;

    jest.spyOn(grnService, '_loadOrThrow').mockResolvedValue(grn);

    const revSpy       = jest.spyOn(transactionService, 'reverseTransaction');
    // INV-3 — cancel reverses each receipt at its RECEIPT cost via
    // applyReceiptReversal (not reduceStock, which costs like a sale).
    const reversalSpy = jest.spyOn(require('../../../services/inventory.service'), 'applyReceiptReversal')
      .mockResolvedValue({ item: {}, removedValue: 0 });

    await grnService.cancel(grn._id, { _id: 'u1', businessId: BIZ }, 'wrong delivery', '0.0.0.0');

    // reverseTransaction must be called exactly once with a session argument
    expect(revSpy).toHaveBeenCalledTimes(1);
    expect(revSpy).toHaveBeenCalledWith(
      'cccccccccccccccccccccccc',
      expect.anything(),
      expect.objectContaining({ session: expect.anything() }),
      'u1',
      '0.0.0.0'
    );

    // applyReceiptReversal called once per stocked line with accepted qty AND receipt cost
    expect(reversalSpy).toHaveBeenCalledTimes(2);
    // Line A: 3 accepted (3 received − 0 rejected) @ receipt cost 100
    expect(reversalSpy).toHaveBeenCalledWith(BIZ, ITEM_A, 3, 100, expect.objectContaining({ session: expect.anything() }));
    // Line B: 4 accepted (5 received − 1 rejected) @ receipt cost 200
    expect(reversalSpy).toHaveBeenCalledWith(BIZ, ITEM_B, 4, 200, expect.objectContaining({ session: expect.anything() }));

    // Guard fields must be cleared inside the txn
    expect(grn.glJournalId).toBeNull();
    expect(grn.inventoryApplied).toBe(false);
    expect(grn.state).toBe('cancelled');
  });

  // A13 — cancel must re-throw if the reversal fails (no swallow)
  test('cancel re-throws when reversal fails (no silent swallow)', async () => {
    const mongoose = require('mongoose');
    const grn = await grnService.createDraft(
      { businessId: BIZ, purchaseOrderId: PO_ID, receivedDate: new Date(),
        receivedItems: [{ poLineItemId: LINE_1, name: 'W', quantityOrdered: 5, quantityReceived: 5, unitCost: 100 }] },
      USER
    );
    grn.state = 'confirmed';
    grn.glJournalId = new mongoose.Types.ObjectId('bbbbbbbbbbbbbbbbbbbbbbbb');
    grn.inventoryApplied = true;

    jest.spyOn(grnService, '_loadOrThrow').mockResolvedValue(grn);

    transactionService.reverseTransaction.mockRejectedValueOnce(new Error('GL reversal failed'));
    await expect(
      grnService.cancel(grn._id, { _id: 'u1', businessId: BIZ }, 'bad receipt', '0.0.0.0')
    ).rejects.toThrow('GL reversal failed');
  });

  // A13 (Finding 2) — cancel must re-throw if stock reversal fails mid-loop (no swallow)
  test('cancel re-throws when stock reversal fails (no silent swallow)', async () => {
    const mongoose = require('mongoose');
    const ITEM_A = new mongoose.Types.ObjectId();

    const grn = await grnService.createDraft(
      { businessId: BIZ, purchaseOrderId: PO_ID, receivedDate: new Date(),
        receivedItems: [
          { poLineItemId: LINE_1, inventoryItemId: ITEM_A, name: 'W', quantityOrdered: 5, quantityReceived: 5, quantityRejected: 0, unitCost: 100 },
        ] },
      USER
    );
    grn.state = 'confirmed';
    grn.glJournalId = new mongoose.Types.ObjectId('dddddddddddddddddddddddd');
    grn.inventoryApplied = true;

    jest.spyOn(grnService, '_loadOrThrow').mockResolvedValue(grn);
    jest.spyOn(require('../../../services/inventory.service'), 'applyReceiptReversal')
      .mockRejectedValueOnce(new Error('stock reduce failed'));

    await expect(
      grnService.cancel(grn._id, { _id: 'u1', businessId: BIZ }, 'bad receipt', '0.0.0.0')
    ).rejects.toThrow('stock reduce failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ERP Step 5 — receive → inventory stock-in
// ─────────────────────────────────────────────────────────────────────────────
describe('grnService.confirm() — inventory stock-in (ERP Step 5)', () => {
  const mongoose = require('mongoose');
  const ITEM_1 = new mongoose.Types.ObjectId();

  let emitSpy;
  beforeEach(() => {
    emitSpy = jest.spyOn(businessEvents, 'emit').mockReturnValue('evt');
  });
  afterEach(() => emitSpy.mockRestore());

  async function makeDraftGRN(receivedItems) {
    return grnService.createDraft(
      { businessId: BIZ, purchaseOrderId: PO_ID, receivedDate: new Date(), receivedItems },
      USER
    );
  }

  test('adds ACCEPTED qty (received − rejected) to inventory at landed unit cost', async () => {
    const grn = await makeDraftGRN([
      { poLineItemId: LINE_1, inventoryItemId: ITEM_1, name: 'Widget',
        quantityOrdered: 10, quantityReceived: 10, quantityRejected: 2, unitCost: 500 },
    ]);
    await grnService.confirm(grn._id, USER, '127.0.0.1');

    expect(inventoryService.applyPurchaseStock).toHaveBeenCalledTimes(1);
    expect(inventoryService.applyPurchaseStock).toHaveBeenCalledWith(
      BIZ, ITEM_1, 8 /* 10 − 2 */, 500,
      expect.objectContaining({ userId: USER._id, session: expect.anything() })
    );
  });

  test('broadcasts GOODS_RECEIVED and sets inventoryApplied', async () => {
    const grn = await makeDraftGRN([
      { poLineItemId: LINE_1, inventoryItemId: ITEM_1, name: 'Widget',
        quantityOrdered: 10, quantityReceived: 10, unitCost: 500 },
    ]);
    const confirmed = await grnService.confirm(grn._id, USER);

    expect(confirmed.inventoryApplied).toBe(true);
    const names = emitSpy.mock.calls.map((c) => c[0]);
    expect(names).toContain(EVENTS.GOODS_RECEIVED);
  });

  test('skips lines without an inventoryItemId (services / untracked customs)', async () => {
    const grn = await makeDraftGRN([
      { poLineItemId: LINE_1, name: 'Consulting', quantityOrdered: 10, quantityReceived: 10, unitCost: 500 },
    ]);
    await grnService.confirm(grn._id, USER);
    expect(inventoryService.applyPurchaseStock).not.toHaveBeenCalled();
  });

  test('does not double-apply stock when already applied (idempotent)', async () => {
    const grn = await makeDraftGRN([
      { poLineItemId: LINE_1, inventoryItemId: ITEM_1, name: 'Widget',
        quantityOrdered: 10, quantityReceived: 10, unitCost: 500 },
    ]);
    await grnService.confirm(grn._id, USER);
    expect(inventoryService.applyPurchaseStock).toHaveBeenCalledTimes(1);

    // Simulate a re-run of the private stock-in on the already-applied GRN.
    await grnService._applyReceivedStock(grn, USER);
    expect(inventoryService.applyPurchaseStock).toHaveBeenCalledTimes(1); // unchanged
  });

  // ── A13: GRNI accrual journal ───────────────────────────────────────────────
  test('confirm posts DR Inventory / CR GRNI for stocked lines and is idempotent', async () => {
    const grn = await makeDraftGRN([
      { poLineItemId: LINE_1, inventoryItemId: ITEM_1, name: 'Widget',
        quantityOrdered: 10, quantityReceived: 10, quantityRejected: 0, unitCost: 50 },
    ]);

    await grnService.confirm(grn._id, USER, '0.0.0.0');

    // One compound GL entry: DR 1150 500 / CR 2115 500, via a session.
    expect(postCompoundJournal).toHaveBeenCalledTimes(1);
    expect(postCompoundJournal).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `grn:accrual:${grn._id}`,
        lines: expect.arrayContaining([
          expect.objectContaining({ accountId: 'inv1',  type: 'debit',  amount: 500 }),
          expect.objectContaining({ accountId: 'grni1', type: 'credit', amount: 500 }),
        ]),
      }),
      expect.objectContaining({ session: expect.anything() }),
    );
    // Guard persisted so a retry converges (no double-post).
    expect(grn.glJournalId).toBe('je-grn-1');
    expect(grn.inventoryApplied).toBe(true);
  });

  // ── A14: stop swallowing the stock-in / GL failure ──────────────────────────
  test('confirm re-throws when the inventory accrual fails (no silent stock-in)', async () => {
    const grn = await makeDraftGRN([
      { poLineItemId: LINE_1, inventoryItemId: ITEM_1, name: 'X',
        quantityOrdered: 5, quantityReceived: 5, quantityRejected: 0, unitCost: 20 },
    ]);
    postCompoundJournal.mockRejectedValueOnce(new Error('GL down'));
    await expect(grnService.confirm(grn._id, USER, '0.0.0.0')).rejects.toThrow('GL down');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('grnService._detectDiscrepancies()', () => {
  // Test the private detection logic via the service's exposed confirm flow
  test('detects quality_reject when quantityRejected > 0', async () => {
    const grn = await grnService.createDraft(
      { businessId: BIZ, purchaseOrderId: PO_ID, receivedDate: new Date(),
        receivedItems: [{
          poLineItemId: LINE_1, name: 'Widget',
          quantityOrdered: 10, quantityReceived: 10, quantityRejected: 2, unitCost: 500,
        }] },
      USER
    );
    const confirmed = await grnService.confirm(grn._id, USER);
    expect(confirmed.discrepancies.some(d => d.type === 'quality_reject')).toBe(true);
  });
});

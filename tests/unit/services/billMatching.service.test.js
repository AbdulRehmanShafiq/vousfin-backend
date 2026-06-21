/**
 * tests/unit/services/billMatching.service.test.js
 *
 * Phase 3.2 — Unit tests for the 3-way matching engine.
 * Tests use Jest and do NOT require a running MongoDB — all DB interactions
 * are mocked at the module boundary.
 */
'use strict';

// ── Valid ObjectId strings (24-char hex) ────────────────────────────────────
const ID_BILL    = '507f1f77bcf86cd799439011';
const ID_BILL2   = '507f1f77bcf86cd799439012';
const ID_PO      = '507f1f77bcf86cd799439013';
const ID_GRN     = '507f1f77bcf86cd799439014';
const ID_VENDOR  = '507f1f77bcf86cd799439015';
const ID_BIZ     = '507f1f77bcf86cd799439016';
const ID_ITEM    = '507f1f77bcf86cd799439017';

// ── Mock helper: thenable query (supports both direct await AND .lean()) ────
function mockQuery(value) {
  const p = Promise.resolve(value);
  return {
    lean:  () => p,
    then:  p.then.bind(p),
    catch: p.catch.bind(p),
  };
}

// ── Mock Mongoose models BEFORE loading the service ─────────────────────────
jest.mock('../../../models/Bill.model',          () => ({ findOne: jest.fn() }));
jest.mock('../../../models/PurchaseOrder.model', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/GoodsReceipt.model',  () => ({ find:    jest.fn() }));

const Bill          = require('../../../models/Bill.model');
const PurchaseOrder = require('../../../models/PurchaseOrder.model');
const GoodsReceipt  = require('../../../models/GoodsReceipt.model');

// Service under test (loaded AFTER mocks)
const svc = require('../../../services/billMatching.service');
const { THREE_WAY_MATCH_STATUSES: S } = require('../../../config/constants');

// ── Data factories ────────────────────────────────────────────────────────────

function makeBill(overrides = {}) {
  return {
    _id:                   ID_BILL,
    billNumber:            'BILL-2025-00001',
    businessId:            ID_BIZ,
    purchaseOrderId:       ID_PO,
    linkedGrnIds:          [ID_GRN],
    vendorId:              ID_VENDOR,
    vendorReferenceNumber: 'INV-VENDOR-001',
    amount:                1000,
    totalAmount:           1180,
    taxAmount:             180,
    issueDate:             new Date('2025-01-15'),
    currencyCode:          'PKR',
    lineItems: [
      { name: 'Widget A', quantity: 10, unitPrice: 100, inventoryItemId: ID_ITEM, accountId: null },
    ],
    threeWayMatchStatus: 'none',
    matchResult:         null,
    save:                jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makePO(overrides = {}) {
  return {
    _id:         ID_PO,
    businessId:  ID_BIZ,
    totalAmount: 1180,
    lineItems: [
      {
        _id:              'poline-1',
        name:             'Widget A',
        inventoryItemId:  ID_ITEM,
        quantityOrdered:  10,
        quantityReceived: 10,
        unitPrice:        100,
      },
    ],
    ...overrides,
  };
}

function makeGRN(overrides = {}) {
  return {
    _id:                ID_GRN,
    state:              'confirmed',
    totalReceivedValue: 1000,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BillMatchingService', () => {

  // resetAllMocks (not clearAllMocks) — clears mockReturnValueOnce queues too,
  // preventing leftover mocked values from one test bleeding into the next.
  afterEach(() => jest.resetAllMocks());

  // ── validateQuantityVariance ──────────────────────────────────────────────

  describe('validateQuantityVariance()', () => {
    it('returns ok when billed = received = ordered', () => {
      const r = svc.validateQuantityVariance(10, 10, 10);
      expect(r.level).toBe('ok');
    });

    it('returns warn when billed > received by ~10% (block threshold is 15%)', () => {
      const r = svc.validateQuantityVariance(11, 10, 10);
      expect(r.level).toBe('warn');
      expect(r.overBilledPct).toBeGreaterThan(0);
    });

    it('returns block when billed > received by ~20% (block threshold is 15%)', () => {
      const r = svc.validateQuantityVariance(12, 10, 10);
      expect(r.level).toBe('block');
    });

    it('returns warn when received < ordered by 10% (block threshold is 15%)', () => {
      // billed 9, ordered 10, received 9 → under-received 10%
      const r = svc.validateQuantityVariance(9, 10, 9);
      expect(r.level).toBe('warn');
    });

    it('returns ok when under-received is within warn threshold (~2%)', () => {
      const r = svc.validateQuantityVariance(10, 10, 9.8);
      expect(r.level).toBe('ok');
    });

    it('BLOCKS when goods are billed but NONE were received (audit A11)', () => {
      // billed 100, ordered 100, received 0 → the classic "billed for goods never
      // received" case. The old pct() returned 0 on divide-by-zero → wrongly 'ok'.
      const r = svc.validateQuantityVariance(100, 100, 0);
      expect(r.level).toBe('block');
    });

    it('BLOCKS over-billing against zero received (audit A11)', () => {
      const r = svc.validateQuantityVariance(50, 0, 0); // billed 50, received 0
      expect(r.level).toBe('block');
    });
  });

  // ── validatePriceVariance ─────────────────────────────────────────────────

  describe('validatePriceVariance()', () => {
    it('returns ok when prices are identical', () => {
      const r = svc.validatePriceVariance(100, 100);
      expect(r.level).toBe('ok');
    });

    it('returns warn when price variance is ~5% (warn=3, block=10)', () => {
      const r = svc.validatePriceVariance(105, 100);
      expect(r.level).toBe('warn');
      expect(r.variancePct).toBeCloseTo(5, 1);
    });

    it('returns block when price variance is ~15% (block=10)', () => {
      const r = svc.validatePriceVariance(115, 100);
      expect(r.level).toBe('block');
    });

    it('handles zero PO unit price gracefully (returns ok)', () => {
      const r = svc.validatePriceVariance(100, 0);
      expect(r.level).toBe('ok'); // pct(100, 0) = 0 due to zero guard
    });
  });

  // ── matchBillToPO ─────────────────────────────────────────────────────────

  describe('matchBillToPO()', () => {
    const cfg = { quantity: { warn: 5, block: 15 }, price: { warn: 3, block: 10 } };

    it('returns matched when all lines reconcile within tolerance', () => {
      const bill = makeBill();
      const po   = makePO();
      const r    = svc.matchBillToPO(bill, po, cfg);
      expect(r.status).toBe(S.MATCHED);
      expect(r.lineVariances).toHaveLength(1);
      expect(r.lineVariances[0].matched).toBe(true);
    });

    it('returns blocked when a bill line has no PO counterpart', () => {
      const bill = makeBill({
        lineItems: [{ name: 'Unknown Item', quantity: 5, unitPrice: 50 }],
      });
      const po = makePO();
      const r  = svc.matchBillToPO(bill, po, cfg);
      expect(r.status).toBe(S.BLOCKED);
      expect(r.lineVariances[0].matched).toBe(false);
    });

    it('returns mismatch/blocked when price variance exceeds warn threshold', () => {
      const bill = makeBill({
        lineItems: [{ name: 'Widget A', quantity: 10, unitPrice: 106, inventoryItemId: ID_ITEM }],
      });
      const po = makePO();
      const r  = svc.matchBillToPO(bill, po, cfg);
      // 6% price variance → warn → mismatch
      expect([S.MISMATCH, S.BLOCKED]).toContain(r.status);
    });

    it('returns none when po is null', () => {
      const r = svc.matchBillToPO(makeBill(), null, cfg);
      expect(r.status).toBe(S.NONE);
    });

    it('returns pending when bill has no line items', () => {
      const bill = makeBill({ lineItems: [] });
      const po   = makePO();
      const r    = svc.matchBillToPO(bill, po, cfg);
      expect(r.status).toBe(S.PENDING);
    });
  });

  // ── matchBillToGRN ────────────────────────────────────────────────────────

  describe('matchBillToGRN()', () => {
    const cfg = { total: { warn: 5, block: 15 } };

    it('returns matched when bill total equals GRN total', () => {
      const bill = makeBill({ totalAmount: 1000 });
      const grns = [makeGRN({ totalReceivedValue: 1000 })];
      const r    = svc.matchBillToGRN(bill, grns, cfg);
      expect(r.status).toBe(S.MATCHED);
      expect(r.variance).toBe(0);
    });

    it('returns over_billed when bill > GRN by 10% (warn threshold 5%)', () => {
      const bill = makeBill({ totalAmount: 1100 });
      const grns = [makeGRN({ totalReceivedValue: 1000 })];
      const r    = svc.matchBillToGRN(bill, grns, cfg);
      expect(r.status).toBe(S.OVER_BILLED);
    });

    it('returns blocked when bill > GRN by 20% (block threshold 15%)', () => {
      const bill = makeBill({ totalAmount: 1200 });
      const grns = [makeGRN({ totalReceivedValue: 1000 })];
      const r    = svc.matchBillToGRN(bill, grns, cfg);
      expect(r.status).toBe(S.BLOCKED);
    });

    it('returns matched when bill < GRN (under-billed is acceptable)', () => {
      const bill = makeBill({ totalAmount: 900 });
      const grns = [makeGRN({ totalReceivedValue: 1000 })];
      const r    = svc.matchBillToGRN(bill, grns, cfg);
      expect(r.status).toBe(S.MATCHED);
    });

    it('returns none when no GRNs provided', () => {
      const r = svc.matchBillToGRN(makeBill(), [], cfg);
      expect(r.status).toBe(S.NONE);
    });

    it('sums totalReceivedValue across multiple GRNs', () => {
      const bill = makeBill({ totalAmount: 1000 });
      const grns = [
        makeGRN({ totalReceivedValue: 600 }),
        makeGRN({ totalReceivedValue: 400 }),
      ];
      const r = svc.matchBillToGRN(bill, grns, cfg);
      expect(r.totalReceived).toBe(1000);
      expect(r.status).toBe(S.MATCHED);
    });
  });

  // ── detectDuplicateVendorInvoice ──────────────────────────────────────────

  describe('detectDuplicateVendorInvoice()', () => {
    it('skips DB query and returns false when vendorReferenceNumber is empty', async () => {
      const r = await svc.detectDuplicateVendorInvoice(ID_BIZ, ID_VENDOR, '', 1000, new Date());
      expect(r.isDuplicate).toBe(false);
      expect(Bill.findOne).not.toHaveBeenCalled();
    });

    it('returns isDuplicate=false when no matching bill in DB', async () => {
      Bill.findOne.mockReturnValueOnce(mockQuery(null));
      const r = await svc.detectDuplicateVendorInvoice(ID_BIZ, ID_VENDOR, 'INV-001', 1000, new Date());
      expect(r.isDuplicate).toBe(false);
    });

    it('returns isDuplicate=true and conflicting bill when duplicate found', async () => {
      Bill.findOne.mockReturnValueOnce(mockQuery({ _id: ID_BILL2, billNumber: 'BILL-2025-00002' }));
      const r = await svc.detectDuplicateVendorInvoice(ID_BIZ, ID_VENDOR, 'INV-001', 1000, new Date());
      expect(r.isDuplicate).toBe(true);
      expect(r.conflictingBillNumber).toBe('BILL-2025-00002');
    });
  });

  // ── generateMatchStatus ───────────────────────────────────────────────────

  describe('generateMatchStatus()', () => {
    it('escalates to blocked when duplicate is detected', () => {
      expect(svc.generateMatchStatus(
        { status: S.MATCHED }, { status: S.MATCHED }, { isDuplicate: true }
      )).toBe(S.BLOCKED);
    });

    it('returns blocked when po sub-check is blocked', () => {
      expect(svc.generateMatchStatus(
        { status: S.BLOCKED }, { status: S.MATCHED }, { isDuplicate: false }
      )).toBe(S.BLOCKED);
    });

    it('returns over_billed when grn sub-check is over_billed', () => {
      expect(svc.generateMatchStatus(
        { status: S.MATCHED }, { status: S.OVER_BILLED }, { isDuplicate: false }
      )).toBe(S.OVER_BILLED);
    });

    it('returns under_received when grn sub-check is under_received', () => {
      expect(svc.generateMatchStatus(
        { status: S.MATCHED }, { status: S.UNDER_RECEIVED }, { isDuplicate: false }
      )).toBe(S.UNDER_RECEIVED);
    });

    it('returns matched when all checks pass', () => {
      expect(svc.generateMatchStatus(
        { status: S.MATCHED }, { status: S.MATCHED }, { isDuplicate: false }
      )).toBe(S.MATCHED);
    });
  });

  // ── runFullMatch ──────────────────────────────────────────────────────────

  describe('runFullMatch()', () => {

    it('throws 400 for a non-ObjectId billId', async () => {
      await expect(svc.runFullMatch('not-an-objectid', ID_BIZ))
        .rejects.toMatchObject({ statusCode: 400 });
    });

    it('throws 404 when bill is not found in DB', async () => {
      Bill.findOne.mockReturnValueOnce(mockQuery(null));
      await expect(svc.runFullMatch(ID_BILL, ID_BIZ))
        .rejects.toMatchObject({ statusCode: 404 });
    });

    it('sets status to none and returns early when no PO is linked', async () => {
      const bill = makeBill({ purchaseOrderId: null });
      Bill.findOne.mockReturnValueOnce(mockQuery(bill));

      const result = await svc.runFullMatch(ID_BILL, ID_BIZ);

      expect(result.status).toBe(S.NONE);
      expect(bill.save).toHaveBeenCalledTimes(1);
    });

    it('returns matched status for a perfect PO ↔ GRN ↔ Bill match', async () => {
      const bill = makeBill({ totalAmount: 1000 });
      const po   = makePO({
        lineItems: [{
          name: 'Widget A', inventoryItemId: ID_ITEM,
          quantityOrdered: 10, quantityReceived: 10, unitPrice: 100,
        }],
      });
      const grn = makeGRN({ totalReceivedValue: 1000 });

      Bill.findOne.mockReturnValueOnce(mockQuery(bill));         // load bill
      PurchaseOrder.findOne.mockResolvedValueOnce(po);           // load PO
      GoodsReceipt.find.mockReturnValueOnce(mockQuery([grn]));  // load GRNs (.lean())
      Bill.findOne.mockReturnValueOnce(mockQuery(null));         // dup check → none

      const result = await svc.runFullMatch(ID_BILL, ID_BIZ);

      expect(result.status).toBe(S.MATCHED);
      expect(bill.save).toHaveBeenCalled();
      expect(result.matchResult.summary).toBe('All checks passed');
    });

    it('returns blocked status when duplicate invoice is detected', async () => {
      const bill = makeBill({ totalAmount: 1000 });
      const po   = makePO();
      const grn  = makeGRN({ totalReceivedValue: 1000 });

      Bill.findOne.mockReturnValueOnce(mockQuery(bill));         // load bill
      PurchaseOrder.findOne.mockResolvedValueOnce(po);           // load PO
      GoodsReceipt.find.mockReturnValueOnce(mockQuery([grn]));  // load GRNs (.lean())
      Bill.findOne.mockReturnValueOnce(mockQuery({              // dup check → FOUND
        _id: ID_BILL2, billNumber: 'BILL-DUP',
      }));

      const result = await svc.runFullMatch(ID_BILL, ID_BIZ);

      expect(result.status).toBe(S.BLOCKED);
      expect(result.matchResult.duplicateCheck.isDuplicate).toBe(true);
      expect(result.matchResult.duplicateCheck.conflictingBillNumber).toBe('BILL-DUP');
    });
  });
});

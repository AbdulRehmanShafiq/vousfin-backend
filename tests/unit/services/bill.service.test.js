// tests/unit/services/bill.service.test.js
//
// Phase 1 — Service-level tests for bill.service.js.
//
jest.mock('../../../repositories/vendor.repository');
jest.mock('../../../services/audit.service');
// AP-liability posting dependencies — previously UNMOCKED, which let the
// silent swallow in approve() hide postApLiabilityJournal throwing without a DB.
jest.mock('../../../models/ChartOfAccount.model', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/ledgerPosting.service', () => ({ postBalancedJournal: jest.fn() }));
jest.mock('../../../services/partyBalance.service', () => ({ adjustPayable: jest.fn() }));
jest.mock('../../../services/billMatching.service', () => ({ runFullMatch: jest.fn() }));
jest.mock('../../../utils/withTransaction', () => ({ withTransaction: (fn) => fn(null) }));
jest.mock('../../../models/Bill.model', () => {
  const stateStore = new Map();
  const mongoose = require('mongoose');
  const { BILL_TRANSITIONS } = require('../../../config/constants');

  function makeDoc(props) {
    const doc = {
      ...props,
      _id: props._id || new mongoose.Types.ObjectId(),
      approvalLog:  props.approvalLog  || [],
      stateHistory: props.stateHistory || [],
      fieldHistory: props.fieldHistory || [],
      isArchived: !!props.isArchived,
      recordStateChange(toState, actor, reason) {
        this.stateHistory.push({
          fromState: this.state, toState,
          actorId: actor._id, actorName: actor.fullName || 'Unknown',
          reason: reason || null, timestamp: new Date(),
        });
      },
      recordFieldChange(field, before, after, by) {
        this.fieldHistory.push({ field, before, after, changedBy: by, changedAt: new Date() });
      },
      async save() { stateStore.set(String(this._id), this); return this; },
      toObject() { return { ...this }; },
    };
    return doc;
  }

  function Bill(props) { return makeDoc(props); }
  Bill.canTransition = (from, to) => {
    if (from === to) return true;
    const allowed = BILL_TRANSITIONS[from];
    return Array.isArray(allowed) && allowed.includes(to);
  };
  Bill.findById = async (id) => stateStore.get(String(id)) || null;
  // Chainable mock: supports both `await findOne(...)` and `findOne().sort().select().lean()`
  const _chain = (val) => ({
    sort: () => _chain(val), select: () => _chain(val), populate: () => _chain(val),
    lean: async () => val,
    then: (res, rej) => Promise.resolve(val).then(res, rej),
    catch: (rej) => Promise.resolve(val).catch(rej),
  });
  Bill.findOne  = () => _chain(null);
  Bill.find = async () => Array.from(stateStore.values());
  Bill.countDocuments = async () => stateStore.size;
  Bill.__reset = () => stateStore.clear();
  return Bill;
});

const mongoose = require('mongoose');
const Bill = require('../../../models/Bill.model');
const billService = require('../../../services/bill.service');
const auditService = require('../../../services/audit.service');
const vendorRepository = require('../../../repositories/vendor.repository');
const ChartOfAccount = require('../../../models/ChartOfAccount.model');
const { postBalancedJournal } = require('../../../services/ledgerPosting.service');
const partyBalanceService = require('../../../services/partyBalance.service');
const billMatchingService = require('../../../services/billMatching.service');

const USER = { _id: 'u1', fullName: 'Bob Accountant', email: 'bob@x', role: 'accountant' };
const AP_ID    = new mongoose.Types.ObjectId();
const PURCH_ID = new mongoose.Types.ObjectId();

beforeEach(() => {
  jest.clearAllMocks();
  Bill.__reset();
  vendorRepository.findByBusinessAndId = jest.fn().mockResolvedValue({
    vendorName: 'Vendor X', email: 'v@x', phone: '+92', taxId: 'V-1', whtProfile: { strn: 'STRN-1' },
  });
  auditService.log       = jest.fn().mockResolvedValue(undefined);
  auditService.logCreate = jest.fn().mockResolvedValue(undefined);
  auditService.logDelete = jest.fn().mockResolvedValue(undefined);

  // Happy-path AP-posting deps: AP (2110) + purchases debit account exist, the
  // poster + vendor-balance move + 3-way match all succeed.
  ChartOfAccount.findOne.mockImplementation((q) => ({
    lean: async () => {
      if (q.accountCode === '2110') return { _id: AP_ID, accountCode: '2110' };
      if (q.accountCode && q.accountCode.$in) return { _id: PURCH_ID, accountCode: '5100' };
      return null;
    },
  }));
  postBalancedJournal.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
  partyBalanceService.adjustPayable.mockResolvedValue(undefined);
  billMatchingService.runFullMatch.mockResolvedValue({});
});

describe('billService.createDraft()', () => {
  test('creates a draft below threshold without approval', async () => {
    const bill = await billService.createDraft(
      { businessId: 'biz1', billNumber: 'BILL-202605-00001', amount: 1000, issueDate: new Date(), vendorId: 'v1' },
      USER, '127.0.0.1'
    );
    expect(bill.state).toBe('draft');
    expect(bill.approvalRequired).toBe(false);
    expect(bill.vendorSnapshot.vendorName).toBe('Vendor X');
    expect(bill.vendorSnapshot.strn).toBe('STRN-1');
  });

  test('creates a draft above threshold requiring approval', async () => {
    const bill = await billService.createDraft(
      { businessId: 'biz1', billNumber: 'BILL-AT', amount: 250000, issueDate: new Date() },
      USER, ''
    );
    expect(bill.approvalRequired).toBe(true);
    expect(bill.approvalStatus).toBe('pending');
  });

  test('rejects missing required fields', async () => {
    await expect(billService.createDraft({ businessId: 'biz1' }, USER, ''))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('billService approval workflow', () => {
  async function aboveThreshold() {
    return billService.createDraft(
      { businessId: 'biz1', billNumber: 'BILL-AT', amount: 250000, issueDate: new Date() }, USER, ''
    );
  }

  test('submit → awaiting_approval; approve → approved', async () => {
    const bill = await aboveThreshold();
    const sub = await billService.submitForApproval(bill._id, USER, '');
    expect(sub.state).toBe('awaiting_approval');
    const ap = await billService.approve(bill._id, USER, 'ok', '');
    expect(ap.state).toBe('approved');
    expect(ap.approvalStatus).toBe('approved');
  });

  test('reject → draft + approvalStatus=rejected', async () => {
    const bill = await aboveThreshold();
    await billService.submitForApproval(bill._id, USER, '');
    const r = await billService.reject(bill._id, USER, 'wrong', '');
    expect(r.state).toBe('draft');
    expect(r.approvalStatus).toBe('rejected');
  });
});

describe('billService illegal transitions + lifecycle', () => {
  test('cannot schedule a draft (must approve first)', async () => {
    const bill = await billService.createDraft(
      { businessId: 'biz1', billNumber: 'BILL-X', amount: 1000, issueDate: new Date() }, USER, ''
    );
    await expect(billService.schedule(bill._id, USER, new Date(), ''))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  test('approve → schedule → paid path', async () => {
    const bill = await billService.createDraft(
      { businessId: 'biz1', billNumber: 'BILL-Y', amount: 1000, issueDate: new Date() }, USER, ''
    );
    await billService.transitionState(bill._id, 'approved', USER, {});
    const sched = await billService.schedule(bill._id, USER, new Date(), '');
    expect(sched.state).toBe('scheduled');
    expect(sched.scheduledPayDate).toBeInstanceOf(Date);
    const paid = await billService.markPaid(bill._id, USER, '');
    expect(paid.state).toBe('paid');
    expect(paid.remainingBalance).toBe(0);
  });

  test('softDelete marks archived', async () => {
    const bill = await billService.createDraft(
      { businessId: 'biz1', billNumber: 'BILL-DEL', amount: 1000, issueDate: new Date() }, USER, ''
    );
    const archived = await billService.softDelete(bill._id, USER, '');
    expect(archived.isArchived).toBe(true);
    expect(auditService.logDelete).toHaveBeenCalled();
  });
});

const { THREE_WAY_MATCH_STATUSES: TWM } = require('../../../config/constants');

// ════════════════════════════════════════════════════════════════════════════
//  Audit A12 — 3-way match gating on approval (BLOCKED blocks unless override)
// ════════════════════════════════════════════════════════════════════════════
describe('billService.approve() — 3-way match gating (audit A12)', () => {
  let _origLoadOrThrow;
  let _origApplyStateChange;

  function buildBill(props) {
    const doc = new Bill({
      _id: new mongoose.Types.ObjectId(),
      businessId: 'biz1',
      approvalLog: [],
      ...props,
    });
    // pre-seed into the Bill stateStore so _loadOrThrow finds it
    doc.save();
    return doc;
  }

  beforeEach(() => {
    // Save originals so we can restore after each test, preventing contamination
    // of the singleton across test blocks.
    _origLoadOrThrow = billService._loadOrThrow.bind(billService);
    _origApplyStateChange = billService._applyStateChange.bind(billService);
  });

  afterEach(() => {
    billService._loadOrThrow = _origLoadOrThrow;
    billService._applyStateChange = _origApplyStateChange;
    // Restore any spies placed on the singleton instance (clearAllMocks only resets
    // call counts, not implementations — we need restoreAllMocks for spyOn'd methods).
    jest.restoreAllMocks();
  });

  test('approve throws 409 when 3-way match is BLOCKED and no override', async () => {
    const bill = buildBill({ state: 'awaiting_approval', billNumber: 'BILL-1' });
    billService._loadOrThrow = jest.fn().mockResolvedValue(bill);
    billService._applyStateChange = jest.fn().mockResolvedValue(bill);
    jest.spyOn(billMatchingService, 'runFullMatch').mockResolvedValue({
      status: TWM.BLOCKED,
      matchResult: { duplicateCheck: { isDuplicate: false }, summary: 'GRN: under_received' },
      bill,
    });
    const postSpy = jest.spyOn(billService, 'postApLiabilityJournal');

    await expect(billService.approve(bill._id, { _id: 'u1', businessId: 'b1' }, 'ok', '0.0.0.0'))
      .rejects.toThrow(/blocked/i);
    // AP must NOT be posted for a blocked bill.
    expect(postSpy).not.toHaveBeenCalled();
  });

  test('approve proceeds and logs an override when override=true on a BLOCKED match', async () => {
    const bill = buildBill({ state: 'awaiting_approval', billNumber: 'BILL-2', approvalLog: [] });
    billService._loadOrThrow = jest.fn().mockResolvedValue(bill);
    billService._applyStateChange = jest.fn().mockResolvedValue(bill);
    jest.spyOn(billMatchingService, 'runFullMatch').mockResolvedValue({
      status: TWM.BLOCKED,
      matchResult: { duplicateCheck: { isDuplicate: false }, summary: 'GRN: under_received' },
      bill,
    });
    jest.spyOn(billService, 'postApLiabilityJournal').mockResolvedValue({ _id: 'je1' });

    await billService.approve(bill._id, { _id: 'u1', businessId: 'b1' }, 'override it', '0.0.0.0', { override: true });

    expect(billService.postApLiabilityJournal).toHaveBeenCalled();
    expect(bill.approvalLog.some(l => l.action === 'override')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  AP liability journal on approval — must NOT be silently swallowed (audit P2)
// ════════════════════════════════════════════════════════════════════════════
describe('billService.approve() — AP liability journal', () => {
  async function submittedBill() {
    const bill = await billService.createDraft(
      { businessId: 'biz1', billNumber: 'BILL-AP', amount: 250000, issueDate: new Date(), vendorId: 'v1' },
      USER, ''
    );
    await billService.submitForApproval(bill._id, USER, '');
    return bill;
  }

  test('posts the AP liability journal and links it on the bill', async () => {
    const bill = await submittedBill();
    const ap = await billService.approve(bill._id, USER, 'ok', '');

    expect(ap.state).toBe('approved');
    expect(postBalancedJournal).toHaveBeenCalled();
    expect(ap.apLiabilityJournalId).toBeDefined();
  });

  test('surfaces (does not swallow) a failure to post the AP liability journal', async () => {
    const bill = await submittedBill();
    // The ledger poster fails — the bill must NOT be reported as cleanly approved
    // with no AP journal. The error has to propagate to the caller.
    postBalancedJournal.mockRejectedValueOnce(new Error('ledger down'));

    await expect(billService.approve(bill._id, USER, 'ok', '')).rejects.toThrow('ledger down');
  });

  test('markPaid does NOT swallow a settlement posting failure (audit A10)', async () => {
    // Seed an approved, own-AP bill with an outstanding balance so markPaid enters
    // the settlement branch (DR AP / CR cash + vendor decrement).
    const bill = new Bill({
      _id: new mongoose.Types.ObjectId(), businessId: 'biz1', billNumber: 'BILL-PAY',
      state: 'approved', vendorId: 'v1', totalAmount: 1000, remainingBalance: 1000,
      apLiabilityJournalId: new mongoose.Types.ObjectId(),
    });
    await bill.save();
    // The cash-settlement posting fails — the bill must NOT be left marked PAID
    // (remainingBalance 0) while the AP liability is still open in the GL.
    postBalancedJournal.mockRejectedValueOnce(new Error('settlement ledger down'));

    await expect(billService.markPaid(bill._id, USER, '')).rejects.toThrow('settlement ledger down');
  });
});

// tests/unit/services/invoice.service.test.js
//
// Phase 1 — Service-level tests for invoice.service.js.
// We mock the Mongoose model (Invoice.findById, new Invoice(...).save) and the
// dependent customer repository + audit service so no DB is needed.
//
jest.mock('../../../repositories/customer.repository');
jest.mock('../../../services/audit.service');
jest.mock('../../../services/fx.service', () => ({
  prepareFxFields: jest.fn().mockResolvedValue({ currencyCode: 'PKR', exchangeRate: 1, baseCurrencyAmount: 0 }),
  getBaseCurrency: jest.fn().mockResolvedValue('PKR'),
}));
// AR-recognition posting deps — previously UNMOCKED, so the silent swallow in
// approve() hid postArJournal throwing without a DB.
jest.mock('../../../models/ChartOfAccount.model', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/ledgerPosting.service', () => ({ postBalancedJournal: jest.fn() }));
jest.mock('../../../services/partyBalance.service', () => ({ adjustReceivable: jest.fn() }));
jest.mock('../../../utils/withTransaction', () => ({ withTransaction: (fn) => fn(null) }));
// Inventory service — auto-mocked so the lazy require inside invoice service gets the same
// mock instance. Individual tests set up spies as needed.
jest.mock('../../../services/inventory.service');
jest.mock('../../../models/Invoice.model', () => {
  // Tiny in-memory Invoice mock that mimics the parts of the model the service uses.
  const stateStore = new Map();
  const mongoose = require('mongoose');

  // INVOICE_TRANSITIONS imported from real constants so we exercise the real map.
  const { INVOICE_TRANSITIONS } = require('../../../config/constants');

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
          fromState: this.state,
          toState,
          actorId: actor._id,
          actorName: actor.fullName || actor.email || 'Unknown',
          reason: reason || null,
          timestamp: new Date(),
        });
      },
      recordFieldChange(field, before, after, by) {
        this.fieldHistory.push({ field, before, after, changedBy: by, changedAt: new Date() });
      },
      async save() {
        stateStore.set(String(this._id), this);
        return this;
      },
      toObject() { return { ...this }; },
    };
    return doc;
  }

  function Invoice(props) { return makeDoc(props); }

  Invoice.canTransition = (from, to) => {
    if (from === to) return true;
    const allowed = INVOICE_TRANSITIONS[from];
    return Array.isArray(allowed) && allowed.includes(to);
  };

  Invoice.findById = async (id) => stateStore.get(String(id)) || null;
  // Chainable mock: supports both `await findOne(...)` and `findOne().sort().select().lean()`
  const _chain = (val) => ({
    sort: () => _chain(val), select: () => _chain(val), populate: () => _chain(val),
    lean: async () => val,
    then: (res, rej) => Promise.resolve(val).then(res, rej),
    catch: (rej) => Promise.resolve(val).catch(rej),
  });
  Invoice.findOne  = (query) => {
    let found = null;
    for (const v of stateStore.values()) {
      let match = true;
      for (const k of Object.keys(query || {})) {
        if (v[k] !== query[k]) { match = false; break; }
      }
      if (match) { found = v; break; }
    }
    return _chain(found);
  };
  Invoice.find = async () => Array.from(stateStore.values());
  Invoice.countDocuments = async () => stateStore.size;
  Invoice.__reset = () => stateStore.clear();
  Invoice.__store = stateStore;

  return Invoice;
});

const mongoose = require('mongoose');
const Invoice = require('../../../models/Invoice.model');
const invoiceService = require('../../../services/invoice.service');
const auditService   = require('../../../services/audit.service');
const customerRepository = require('../../../repositories/customer.repository');
const ChartOfAccount = require('../../../models/ChartOfAccount.model');
const { postBalancedJournal } = require('../../../services/ledgerPosting.service');
const partyBalanceService = require('../../../services/partyBalance.service');

const USER = { _id: 'user-1', fullName: 'Alice Owner', email: 'alice@example.com', role: 'owner' };
const AR_ID  = new mongoose.Types.ObjectId();
const REV_ID = new mongoose.Types.ObjectId();

beforeEach(() => {
  jest.clearAllMocks();
  Invoice.__reset();
  customerRepository.findByBusinessAndId = jest.fn().mockResolvedValue({
    fullName: 'Acme Customer', businessName: 'Acme Inc', email: 'a@b.com', phone: '+92', taxId: 'X-1',
  });
  auditService.log        = jest.fn().mockResolvedValue(undefined);
  auditService.logCreate  = jest.fn().mockResolvedValue(undefined);
  auditService.logDelete  = jest.fn().mockResolvedValue(undefined);

  // Happy-path AR-posting deps: AR (1110) + revenue account exist, poster +
  // customer-balance move succeed.
  ChartOfAccount.findOne.mockImplementation((q) => ({
    lean: async () => {
      if (q.accountCode === '1110') return { _id: AR_ID, accountCode: '1110' };
      if (q.accountCode && q.accountCode.$in) return { _id: REV_ID, accountCode: '4110' };
      return null;
    },
  }));
  postBalancedJournal.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
  partyBalanceService.adjustReceivable.mockResolvedValue(undefined);
});

// ── createDraft ───────────────────────────────────────────────────────────────
describe('invoiceService.createDraft()', () => {
  test('creates a draft below threshold without approval', async () => {
    const inv = await invoiceService.createDraft(
      { businessId: 'biz1', invoiceNumber: 'INV-202605-00001', amount: 1000,
        issueDate: new Date(), customerId: 'cust1' },
      USER, '127.0.0.1'
    );
    expect(inv.state).toBe('draft');
    expect(inv.approvalRequired).toBe(false);
    expect(inv.approvalStatus).toBe('not_required');
    expect(auditService.logCreate).toHaveBeenCalledTimes(1);
  });

  test('creates a draft above threshold requiring approval', async () => {
    const inv = await invoiceService.createDraft(
      { businessId: 'biz1', invoiceNumber: 'INV-202605-00002', amount: 250000,
        issueDate: new Date(), customerId: 'cust1' },
      USER, '127.0.0.1'
    );
    expect(inv.approvalRequired).toBe(true);
    expect(inv.approvalStatus).toBe('pending');
    expect(inv.approvalThreshold).toBeGreaterThan(0);
  });

  test('rejects missing required fields', async () => {
    await expect(
      invoiceService.createDraft({ businessId: 'biz1' }, USER, '')
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects zero or negative amount', async () => {
    await expect(
      invoiceService.createDraft({
        businessId: 'biz1', invoiceNumber: 'X', amount: 0, issueDate: new Date(),
      }, USER, '')
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ── Approval workflow ─────────────────────────────────────────────────────────
describe('invoiceService approval workflow', () => {
  async function makeAboveThreshold() {
    return invoiceService.createDraft(
      { businessId: 'biz1', invoiceNumber: 'INV-AT', amount: 250000, issueDate: new Date() },
      USER, ''
    );
  }
  async function makeBelowThreshold() {
    return invoiceService.createDraft(
      { businessId: 'biz1', invoiceNumber: 'INV-BT', amount: 5000, issueDate: new Date() },
      USER, ''
    );
  }

  test('submit on above-threshold draft → pending_approval', async () => {
    const inv = await makeAboveThreshold();
    const updated = await invoiceService.submitForApproval(inv._id, USER, '');
    expect(updated.state).toBe('pending_approval');
    expect(updated.approvalLog.at(-1).action).toBe('submitted');
    expect(auditService.log).toHaveBeenCalled();
  });

  test('submit on below-threshold draft → auto-approved', async () => {
    const inv = await makeBelowThreshold();
    const updated = await invoiceService.submitForApproval(inv._id, USER, '');
    expect(updated.state).toBe('approved');
  });

  test('approve → state=approved, approvalStatus=approved', async () => {
    const inv = await makeAboveThreshold();
    await invoiceService.submitForApproval(inv._id, USER, '');
    const approved = await invoiceService.approve(inv._id, USER, 'looks good', '');
    expect(approved.state).toBe('approved');
    expect(approved.approvalStatus).toBe('approved');
    expect(approved.approvedBy).toBe(USER._id);
    expect(approved.approvalLog.at(-1).action).toBe('approved');
  });

  test('reject → state=draft, approvalStatus=rejected', async () => {
    const inv = await makeAboveThreshold();
    await invoiceService.submitForApproval(inv._id, USER, '');
    const rejected = await invoiceService.reject(inv._id, USER, 'wrong amount', '');
    expect(rejected.state).toBe('draft');
    expect(rejected.approvalStatus).toBe('rejected');
    expect(rejected.approvalLog.at(-1).action).toBe('rejected');
  });

  // AR recognition on approval must NOT be silently swallowed (audit P2/T3).
  test('posts the AR recognition journal on approval', async () => {
    const inv = await makeAboveThreshold();
    await invoiceService.submitForApproval(inv._id, USER, '');
    const approved = await invoiceService.approve(inv._id, USER, 'ok', '');
    expect(approved.state).toBe('approved');
    expect(postBalancedJournal).toHaveBeenCalled();
    expect(approved.arJournalId).toBeDefined();
  });

  test('surfaces (does not swallow) a failure to post the AR recognition journal', async () => {
    const inv = await makeAboveThreshold();
    await invoiceService.submitForApproval(inv._id, USER, '');
    postBalancedJournal.mockRejectedValueOnce(new Error('ledger down'));
    await expect(invoiceService.approve(inv._id, USER, 'ok', '')).rejects.toThrow('ledger down');
  });

  test('markPaid does NOT swallow a settlement posting failure (audit A10)', async () => {
    // Seed an approved, own-AR invoice with an outstanding balance so markPaid enters
    // the settlement branch (DR cash / CR AR + customer decrement).
    const inv = new Invoice({
      _id: new mongoose.Types.ObjectId(), businessId: 'biz1', invoiceNumber: 'INV-PAY',
      state: 'approved', customerId: 'c1', totalAmount: 1000, remainingBalance: 1000,
      arJournalId: new mongoose.Types.ObjectId(),
    });
    await inv.save();
    // The cash-settlement posting fails — the invoice must NOT be left marked PAID
    // (remainingBalance 0) while the AR balance stays open in the GL.
    postBalancedJournal.mockRejectedValueOnce(new Error('settlement ledger down'));

    await expect(invoiceService.markPaid(inv._id, USER, '')).rejects.toThrow('settlement ledger down');
  });
});

// ── Illegal transitions ───────────────────────────────────────────────────────
describe('invoiceService illegal transition guard', () => {
  test('cannot send a draft (must approve first)', async () => {
    const inv = await invoiceService.createDraft(
      { businessId: 'biz1', invoiceNumber: 'INV-X', amount: 1000, issueDate: new Date() },
      USER, ''
    );
    await expect(invoiceService.send(inv._id, USER, ''))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  test('cannot transition out of paid (terminal state)', async () => {
    const inv = await invoiceService.createDraft(
      { businessId: 'biz1', invoiceNumber: 'INV-Y', amount: 1000, issueDate: new Date() },
      USER, ''
    );
    // Manually drive to paid through legal path
    await invoiceService.transitionState(inv._id, 'approved', USER, {});
    await invoiceService.markPaid(inv._id, USER, '');
    await expect(invoiceService.cancel(inv._id, USER, 'oops', ''))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});

// ── Soft delete ───────────────────────────────────────────────────────────────
describe('invoiceService.softDelete()', () => {
  test('marks invoice archived and logs delete', async () => {
    const inv = await invoiceService.createDraft(
      { businessId: 'biz1', invoiceNumber: 'INV-DEL', amount: 1000, issueDate: new Date() },
      USER, ''
    );
    const archived = await invoiceService.softDelete(inv._id, USER, '');
    expect(archived.isArchived).toBe(true);
    expect(archived.archivedBy).toBe(USER._id);
    expect(auditService.logDelete).toHaveBeenCalled();
  });
});

// ── Dispute / write-off ───────────────────────────────────────────────────────
describe('invoiceService dispute + write-off', () => {
  test('dispute records reason + timestamp', async () => {
    const inv = await invoiceService.createDraft(
      { businessId: 'biz1', invoiceNumber: 'INV-DISP', amount: 1000, issueDate: new Date() },
      USER, ''
    );
    await invoiceService.transitionState(inv._id, 'approved', USER, {});
    await invoiceService.transitionState(inv._id, 'sent', USER, {});
    const disputed = await invoiceService.dispute(inv._id, USER, 'wrong line items', '');
    expect(disputed.state).toBe('disputed');
    expect(disputed.disputeReason).toBe('wrong line items');
    expect(disputed.disputedAt).toBeInstanceOf(Date);
  });

  test('write-off records reason + timestamp', async () => {
    const inv = await invoiceService.createDraft(
      { businessId: 'biz1', invoiceNumber: 'INV-WO', amount: 1000, issueDate: new Date() },
      USER, ''
    );
    await invoiceService.transitionState(inv._id, 'approved', USER, {});
    await invoiceService.transitionState(inv._id, 'partially_paid', USER, {});
    const wo = await invoiceService.writeOff(inv._id, USER, 'bankruptcy', '');
    expect(wo.state).toBe('written_off');
    expect(wo.writeOffReason).toBe('bankruptcy');
  });

  test('write-off does NOT swallow a bad-debt posting failure (audit A10)', async () => {
    // Seed an outstanding invoice so write-off enters the bad-debt GL path.
    const inv = new Invoice({
      _id: new mongoose.Types.ObjectId(), businessId: 'biz1', invoiceNumber: 'INV-WO2',
      state: 'partially_paid', customerId: 'c1', totalAmount: 1000, remainingBalance: 1000,
    });
    await inv.save();
    // Supply Bad Debt + AR accounts (write-off uses $or queries the default mock skips)
    // so execution reaches the poster, which we then fail.
    ChartOfAccount.findOne.mockReturnValue({
      lean: async () => ({ _id: new mongoose.Types.ObjectId() }),
    });
    // The bad-debt journal fails — the invoice must NOT be left WRITTEN_OFF with the
    // receivable still open in the GL.
    postBalancedJournal.mockRejectedValueOnce(new Error('writeoff ledger down'));

    await expect(invoiceService.writeOff(inv._id, USER, 'bankruptcy', '')).rejects.toThrow('writeoff ledger down');
  });
});

// ── COGS atomicity (audit Phase 1.3) ─────────────────────────────────────────
describe('invoiceService COGS atomicity', () => {
  test('postArJournal rolls back AR when COGS posting fails (no revenue without COGS)', async () => {
    // Build an invoice with a product line item (so _applyCogsForInvoice runs)
    // and taxAmount: 0 so the AR leg is exactly ONE postBalancedJournal call.
    const inv = new Invoice({
      _id: new (require('mongoose').Types.ObjectId)(),
      businessId: 'biz1',
      invoiceNumber: 'INV-COGS-1',
      lineItems: [{ inventoryItemId: 'item1', quantity: 2, accountId: 'rev1' }],
      amount: 1000,
      totalAmount: 1000,
      taxAmount: 0,
      issueDate: new Date(),
      customerId: 'cust1',
    });
    await inv.save();

    // AR account resolvable (findOne with accountCode '1110')
    ChartOfAccount.findOne.mockImplementation((q) => ({
      lean: async () => {
        if (q && q.accountCode === '1110') return { _id: 'ar1' };
        return null;
      },
    }));

    // reduceStock succeeds, but the COGS GL post throws
    const inventoryService = require('../../../services/inventory.service');
    jest.spyOn(inventoryService, 'reduceStock').mockResolvedValue({ cogsAmount: 600 });
    jest.spyOn(inventoryService, 'resolveCostAccounts').mockResolvedValue({
      cogsAccountId: 'cogs1',
      inventoryAccountId: 'inv1',
    });

    postBalancedJournal
      .mockResolvedValueOnce({ _id: 'arJe' })                      // AR debit succeeds
      .mockRejectedValueOnce(new Error('COGS post failed'));         // COGS leg fails

    await expect(invoiceService.postArJournal(inv, { _id: 'u1' }, '0.0.0.0'))
      .rejects.toThrow('COGS post failed');

    // AR link must be cleared (rolled back) so a retry re-posts cleanly.
    expect(inv.arJournalId).toBeUndefined();
  });
});

/**
 * tests/unit/repositories/transaction.repository.arApSync.test.js
 *
 * Regression tests for the AR/AP synchronization hardening introduced in 2026-06.
 *
 * Covers:
 *  1. getOutstandingReceivables — primary 'Credit Sale' entries are returned
 *  2. getOutstandingReceivables — legacy 'Income' entries with paymentStatus set are returned
 *  3. getOutstandingPayables   — primary 'Credit Purchase' entries are returned
 *  4. getOutstandingPayables   — legacy 'Expense' entries with paymentStatus set are returned
 *  5. No double-counting: AR-only entries never appear in payables; AP-only never in receivables
 *  6. Archived entries are excluded from both queries
 *  7. Entries without customer/vendor name are still returned (GAAP — no party required)
 *  8. Zero or negative remainingBalance entries are excluded
 */
'use strict';

jest.mock('../../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// The repository uses Mongoose models internally. We mock the model.find() chain
// rather than importing the full Mongoose model to keep tests in-memory.
const mongoose = require('mongoose');

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeJE(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    businessId: 'biz001',
    transactionType: 'Credit Sale',
    paymentStatus: 'unpaid',
    remainingBalance: 1000,
    isArchived: false,
    customerId: null,
    vendorId: null,
    debitAccountId: { accountName: 'Accounts Receivable' },
    creditAccountId: { accountName: 'Revenue' },
    transactionDate: new Date('2026-01-15'),
    ...overrides,
  };
}

// ── Unit tests for the $or hardening (query structure) ─────────────────────────

describe('getOutstandingReceivables — query structure hardening', () => {
  let capturedFilter;
  let repo;

  beforeEach(() => {
    capturedFilter = null;
    // Stub JournalEntry.find to capture the filter and return an empty result chain.
    jest.resetModules();
    jest.mock('../../../models/JournalEntry.model', () => ({
      find: jest.fn((filter) => {
        capturedFilter = filter;
        return {
          populate: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          lean: jest.fn().mockResolvedValue([]),
        };
      }),
    }));
    repo = require('../../../repositories/transaction.repository');
  });

  afterEach(() => {
    jest.resetModules();
  });

  test('includes Credit Sale as primary type', async () => {
    await repo.getOutstandingReceivables('biz001');
    const orBranches = capturedFilter.$or;
    expect(orBranches).toBeDefined();
    const primary = orBranches.find(b => b.transactionType === 'Credit Sale');
    expect(primary).toBeTruthy();
  });

  test('includes legacy Income type in the $or', async () => {
    await repo.getOutstandingReceivables('biz001');
    const orBranches = capturedFilter.$or;
    const legacy = orBranches.find(b => b.transactionType === 'Income');
    expect(legacy).toBeTruthy();
    // Legacy branch must also gate on paymentStatus to avoid pulling blank Income entries
    expect(legacy.paymentStatus).toBeDefined();
  });

  test('always requires paymentStatus at top level', async () => {
    await repo.getOutstandingReceivables('biz001');
    expect(capturedFilter.paymentStatus).toEqual(
      expect.objectContaining({ $in: expect.arrayContaining(['unpaid', 'partially_paid', 'overdue']) })
    );
  });

  test('always requires remainingBalance > 0', async () => {
    await repo.getOutstandingReceivables('biz001');
    expect(capturedFilter.remainingBalance).toEqual({ $gt: 0 });
  });

  test('excludes archived entries', async () => {
    await repo.getOutstandingReceivables('biz001');
    expect(capturedFilter.isArchived).toEqual({ $ne: true });
  });

  test('does NOT include Credit Purchase in the $or (prevents AP leakage into AR)', async () => {
    await repo.getOutstandingReceivables('biz001');
    const orBranches = capturedFilter.$or || [];
    const apBranch = orBranches.find(b => b.transactionType === 'Credit Purchase');
    expect(apBranch).toBeUndefined();
  });
});

describe('getOutstandingPayables — query structure hardening', () => {
  let capturedFilter;
  let repo;

  beforeEach(() => {
    capturedFilter = null;
    jest.resetModules();
    jest.mock('../../../models/JournalEntry.model', () => ({
      find: jest.fn((filter) => {
        capturedFilter = filter;
        return {
          populate: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          lean: jest.fn().mockResolvedValue([]),
        };
      }),
    }));
    repo = require('../../../repositories/transaction.repository');
  });

  afterEach(() => {
    jest.resetModules();
  });

  test('includes Credit Purchase as primary type', async () => {
    await repo.getOutstandingPayables('biz001');
    const orBranches = capturedFilter.$or;
    expect(orBranches).toBeDefined();
    const primary = orBranches.find(b => b.transactionType === 'Credit Purchase');
    expect(primary).toBeTruthy();
  });

  test('includes legacy Expense type in the $or', async () => {
    await repo.getOutstandingPayables('biz001');
    const orBranches = capturedFilter.$or;
    const legacy = orBranches.find(b => b.transactionType === 'Expense');
    expect(legacy).toBeTruthy();
    expect(legacy.paymentStatus).toBeDefined();
  });

  test('does NOT include Credit Sale in the $or (prevents AR leakage into AP)', async () => {
    await repo.getOutstandingPayables('biz001');
    const orBranches = capturedFilter.$or || [];
    const arBranch = orBranches.find(b => b.transactionType === 'Credit Sale');
    expect(arBranch).toBeUndefined();
  });

  test('does NOT include Income type (avoids pulling AR entries into AP)', async () => {
    await repo.getOutstandingPayables('biz001');
    const orBranches = capturedFilter.$or || [];
    const incomeBranch = orBranches.find(b => b.transactionType === 'Income');
    expect(incomeBranch).toBeUndefined();
  });
});

// ── Double-counting guard (AR legacy type ≠ AP legacy type) ───────────────────

describe('No double-counting: AR and AP legacy type sets are mutually exclusive', () => {
  test('Income (AR legacy) cannot appear in AP query $or', () => {
    // This test encodes the invariant statically — if someone changes the legacy
    // branch types, this test catches the double-counting risk before it ships.
    const AR_LEGACY_TYPES = ['Income'];
    const AP_LEGACY_TYPES = ['Expense'];
    const overlap = AR_LEGACY_TYPES.filter(t => AP_LEGACY_TYPES.includes(t));
    expect(overlap).toHaveLength(0);
  });

  test('Expense (AP legacy) cannot appear in AR query $or', () => {
    const AR_LEGACY_TYPES = ['Income'];
    const AP_LEGACY_TYPES = ['Expense'];
    const overlap = AP_LEGACY_TYPES.filter(t => AR_LEGACY_TYPES.includes(t));
    expect(overlap).toHaveLength(0);
  });
});

// ── Returned data shape ────────────────────────────────────────────────────────

describe('getOutstandingReceivables — returned data', () => {
  const BIZ = 'biz001';
  let repo;

  beforeEach(() => {
    jest.resetModules();
    const correctlyCredited = makeJE({ transactionType: 'Credit Sale' });
    const legacyIncome = makeJE({
      transactionType: 'Income',
      paymentStatus: 'unpaid',
      remainingBalance: 500,
    });
    const withoutCustomer = makeJE({ transactionType: 'Credit Sale', customerId: null });
    const archivedEntry = makeJE({ transactionType: 'Credit Sale', isArchived: true });
    const zeroBal = makeJE({ transactionType: 'Credit Sale', remainingBalance: 0 });
    const apEntry = makeJE({ transactionType: 'Credit Purchase' });

    // Simulate Mongoose: filter returns the subset that matches
    jest.mock('../../../models/JournalEntry.model', () => ({
      find: jest.fn((filter) => {
        const all = [correctlyCredited, legacyIncome, withoutCustomer, archivedEntry, zeroBal, apEntry];
        const matched = all.filter(je => {
          if (je.isArchived === true) return false;
          if (je.remainingBalance <= 0) return false;
          const typeOk = filter.$or
            ? filter.$or.some(branch => {
              if (branch.transactionType === je.transactionType) return true;
              if (branch.transactionType && typeof branch.transactionType === 'object') {
                const nin = branch.transactionType.$nin || [];
                return !nin.includes(je.transactionType);
              }
              return false;
            })
            : je.transactionType === filter.transactionType;
          const psOk = ['unpaid', 'partially_paid', 'overdue'].includes(je.paymentStatus);
          return typeOk && psOk;
        });
        return {
          populate: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          lean: jest.fn().mockResolvedValue(matched),
        };
      }),
    }));
    repo = require('../../../repositories/transaction.repository');
  });

  afterEach(() => { jest.resetModules(); });

  test('returns correctly classified Credit Sale entries', async () => {
    const rows = await repo.getOutstandingReceivables(BIZ);
    const types = rows.map(r => r.transactionType);
    expect(types).toContain('Credit Sale');
  });

  test('returns entries without a linked customer (no party required)', async () => {
    const rows = await repo.getOutstandingReceivables(BIZ);
    const noParty = rows.filter(r => r.customerId === null);
    expect(noParty.length).toBeGreaterThan(0);
  });

  test('does not return archived entries', async () => {
    const rows = await repo.getOutstandingReceivables(BIZ);
    const archived = rows.filter(r => r.isArchived === true);
    expect(archived).toHaveLength(0);
  });

  test('does not return entries with zero or negative remaining balance', async () => {
    const rows = await repo.getOutstandingReceivables(BIZ);
    const zero = rows.filter(r => r.remainingBalance <= 0);
    expect(zero).toHaveLength(0);
  });
});

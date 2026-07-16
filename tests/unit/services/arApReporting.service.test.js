/**
 * tests/unit/services/arApReporting.service.test.js
 *
 * AR/AP Domain Refactor — Milestone M7 (unified aging read model).
 * Validates aging-bucket accuracy, per-party aging, and reconciliation integrity.
 */
'use strict';

jest.mock('../../../models/Invoice.model', () => ({ find: jest.fn(), aggregate: jest.fn() }));
jest.mock('../../../models/Bill.model', () => ({ find: jest.fn(), aggregate: jest.fn() }));
jest.mock('../../../models/JournalEntry.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../../models/ChartOfAccount.model', () => ({ findOne: jest.fn() }));
// The ledger side of the reconcile is THE open-items union now (spec
// 2026-07-16) — getReconciliation delegates to openItem.sumOpenLedger instead
// of its own JE aggregate, so the union is stubbed here and proven for real
// on the live tier (openItemAuthority.live.test.js).
jest.mock('../../../services/openItem.service', () => ({ sumOpenLedger: jest.fn() }));

const reporting = require('../../../services/arApReporting.service');
const Invoice = require('../../../models/Invoice.model');
const openItemService = require('../../../services/openItem.service');
const ChartOfAccount = require('../../../models/ChartOfAccount.model');

const BIZ = '507f1f77bcf86cd799439060';
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const daysAhead = (n) => new Date(Date.now() + n * 86400000);

beforeEach(() => jest.clearAllMocks());

// ── bucketOf ─────────────────────────────────────────────────────────────────
describe('bucketOf', () => {
  const asOf = new Date();
  it('classifies by days overdue', () => {
    expect(reporting.bucketOf(null, asOf)).toBe('current');
    expect(reporting.bucketOf(daysAhead(10), asOf)).toBe('current');
    expect(reporting.bucketOf(daysAgo(15), asOf)).toBe('1-30');
    expect(reporting.bucketOf(daysAgo(45), asOf)).toBe('31-60');
    expect(reporting.bucketOf(daysAgo(75), asOf)).toBe('61-90');
    expect(reporting.bucketOf(daysAgo(120), asOf)).toBe('90+');
  });
});

// ── getAging ─────────────────────────────────────────────────────────────────
describe('getAging — buckets + per-party (receivable)', () => {
  it('buckets each open invoice and aggregates per customer', async () => {
    const docs = [
      { remainingBalance: 100, dueDate: daysAhead(10), customerId: 'c1', customerSnapshot: { fullName: 'Acme' } },
      { remainingBalance: 200, dueDate: daysAgo(15),   customerId: 'c1', customerSnapshot: { fullName: 'Acme' } },
      { remainingBalance: 300, dueDate: daysAgo(45),   customerId: 'c2', customerSnapshot: { fullName: 'Globex' } },
      { remainingBalance: 50,  dueDate: null,          customerId: 'c2', customerSnapshot: { fullName: 'Globex' } },
    ];
    Invoice.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(docs) }) });

    const res = await reporting.getAging(BIZ, 'receivable');

    expect(res.buckets.total.amount).toBe(650);
    expect(res.buckets.current.amount).toBe(150); // 100 (future) + 50 (no due date)
    expect(res.buckets['1-30'].amount).toBe(200);
    expect(res.buckets['31-60'].amount).toBe(300);
    expect(res.buckets['90+'].amount).toBe(0);

    // sorted by total desc → Globex (350) before Acme (300)
    expect(res.parties[0].name).toBe('Globex');
    expect(res.parties[0].total).toBe(350);
    expect(res.parties[0]['31-60']).toBe(300);
    expect(res.parties[1].name).toBe('Acme');
    expect(res.parties[1].total).toBe(300);
    expect(res.parties[1]['1-30']).toBe(200);
  });
});

// ── getReconciliation ────────────────────────────────────────────────────────
describe('getReconciliation — document vs ledger', () => {
  it('reports in-sync when document = ledger entries = control', async () => {
    Invoice.aggregate.mockResolvedValue([{ total: 1000 }]);
    openItemService.sumOpenLedger.mockResolvedValue({ journalSide: 1000, documentSide: 0, total: 1000 });
    ChartOfAccount.findOne.mockReturnValue({ lean: () => Promise.resolve({ runningBalance: 1000 }) });

    const r = await reporting.getReconciliation(BIZ, 'receivable');
    expect(r.documentTotal).toBe(1000);
    expect(r.ledgerEntriesTotal).toBe(1000);
    expect(r.ledgerControl).toBe(1000);
    expect(r.discrepancyVsEntries).toBe(0);
    expect(r.inSync).toBe(true);
  });

  it('flags a discrepancy when the document total diverges from the ledger', async () => {
    Invoice.aggregate.mockResolvedValue([{ total: 1000 }]);
    openItemService.sumOpenLedger.mockResolvedValue({ journalSide: 950, documentSide: 0, total: 950 });
    ChartOfAccount.findOne.mockReturnValue({ lean: () => Promise.resolve({ runningBalance: 950 }) });

    const r = await reporting.getReconciliation(BIZ, 'receivable');
    expect(r.discrepancyVsEntries).toBe(50);
    expect(r.inSync).toBe(false);
  });

  it('handles empty results (no open documents)', async () => {
    Invoice.aggregate.mockResolvedValue([]);
    openItemService.sumOpenLedger.mockResolvedValue({ journalSide: 0, documentSide: 0, total: 0 });
    ChartOfAccount.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });

    const r = await reporting.getReconciliation(BIZ, 'receivable');
    expect(r).toMatchObject({ documentTotal: 0, ledgerEntriesTotal: 0, ledgerControl: 0, inSync: true });
  });
});

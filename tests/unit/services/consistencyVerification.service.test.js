/**
 * tests/unit/services/consistencyVerification.service.test.js
 *
 * AR/AP Domain Refactor — Milestone M9 (consistency verification).
 * Validates the document↔projection cross-check and the overall inSync verdict.
 */
'use strict';

jest.mock('../../../models/Invoice.model', () => ({ find: jest.fn() }));
jest.mock('../../../models/Bill.model', () => ({ find: jest.fn() }));
jest.mock('../../../models/JournalEntry.model', () => ({ findById: jest.fn(), countDocuments: jest.fn().mockResolvedValue(0) }));
jest.mock('../../../services/arApReporting.service', () => ({ getReconciliation: jest.fn() }));
jest.mock('../../../config', () => ({ AR_AP_AUTHORITATIVE: true }));

const svc = require('../../../services/consistencyVerification.service');
const Invoice = require('../../../models/Invoice.model');
const Bill = require('../../../models/Bill.model');
const JournalEntry = require('../../../models/JournalEntry.model');
const reporting = require('../../../services/arApReporting.service');

const BIZ = '507f1f77bcf86cd799439060';
const findChain = (rows) => ({ select: () => ({ lean: () => Promise.resolve(rows) }) });
const jeChain = (val) => ({ select: () => ({ lean: () => Promise.resolve(val) }) });

beforeEach(() => {
  jest.clearAllMocks();
  reporting.getReconciliation.mockResolvedValue({ inSync: true, documentTotal: 100, ledgerControl: 100 });
  JournalEntry.countDocuments.mockResolvedValue(0);
});

describe('verify', () => {
  // Spec 2026-07-16: the doc↔JE remaining cross-check governs the
  // TRANSACTION-FIRST population (the JE owns the balance, the doc mirrors
  // it). A projection deliberately carries NO balance — the document is the
  // authority, so there is nothing to cross-check (fourth test below).
  it('reports inSync when a mirrored document matches the JE that owns its balance', async () => {
    Invoice.find.mockReturnValue(findChain([{ _id: 'i1', invoiceNumber: 'INV-1', remainingBalance: 50, linkedJournalEntryId: 'je1' }]));
    Bill.find.mockReturnValue(findChain([]));
    JournalEntry.findById.mockReturnValue(jeChain({ remainingBalance: 50, isProjection: false }));

    const res = await svc.verify(BIZ);
    expect(res.inSync).toBe(true);
    expect(res.mode).toBe('document_authoritative');
    expect(res.receivable.documentCrossCheck.discrepancies).toHaveLength(0);
  });

  it('flags a mirrored document that drifted from the JE that owns its balance', async () => {
    Invoice.find.mockReturnValue(findChain([{ _id: 'i1', invoiceNumber: 'INV-1', remainingBalance: 80, linkedJournalEntryId: 'je1' }]));
    Bill.find.mockReturnValue(findChain([]));
    JournalEntry.findById.mockReturnValue(jeChain({ remainingBalance: 50, isProjection: false }));

    const res = await svc.verify(BIZ);
    expect(res.inSync).toBe(false);
    const d = res.receivable.documentCrossCheck.discrepancies[0];
    expect(d.issue).toBe('remaining_mismatch');
    expect(d.delta).toBe(30);
  });

  it('does NOT flag an invoice-first document — its projection carries no balance by design', async () => {
    Invoice.find.mockReturnValue(findChain([{ _id: 'i1', invoiceNumber: 'INV-1', remainingBalance: 2500, arJournalId: 'je1' }]));
    Bill.find.mockReturnValue(findChain([]));
    JournalEntry.findById.mockReturnValue(jeChain({ remainingBalance: null, isProjection: true }));

    const res = await svc.verify(BIZ);
    expect(res.inSync).toBe(true);
    expect(res.receivable.documentCrossCheck.discrepancies).toHaveLength(0);
  });

  it('flags an open document with no recognition journal', async () => {
    Invoice.find.mockReturnValue(findChain([{ _id: 'i1', invoiceNumber: 'INV-1', remainingBalance: 80, arJournalId: null, linkedJournalEntryId: null }]));
    Bill.find.mockReturnValue(findChain([]));

    const res = await svc.verify(BIZ);
    expect(res.inSync).toBe(false);
    expect(res.receivable.documentCrossCheck.discrepancies[0].issue).toBe('no_recognition_journal');
  });

  it('propagates a control-account reconciliation break', async () => {
    Invoice.find.mockReturnValue(findChain([]));
    Bill.find.mockReturnValue(findChain([]));
    reporting.getReconciliation.mockResolvedValueOnce({ inSync: false }).mockResolvedValueOnce({ inSync: true });
    const res = await svc.verify(BIZ);
    expect(res.inSync).toBe(false);
  });
});

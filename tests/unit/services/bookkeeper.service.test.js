'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../services/nlParser', () => ({ parseTransaction: jest.fn() }));
jest.mock('../../../services/actionRouter.service', () => ({ propose: jest.fn() }));
jest.mock('../../../services/entityMemory.service', () => ({ learn: jest.fn(), suggest: jest.fn() }));
jest.mock('../../../services/transaction.service', () => ({ createTransaction: jest.fn(), reverseTransaction: jest.fn() }));
jest.mock('../../../repositories/account.repository', () => ({ findByBusiness: jest.fn() }));
jest.mock('../../../repositories/business.repository', () => ({ findById: jest.fn() }));
jest.mock('../../../repositories/sourceDocument.repository', () => ({ create: jest.fn(), update: jest.fn(), findById: jest.fn() }));

const { parseTransaction } = require('../../../services/nlParser');
const actionRouter = require('../../../services/actionRouter.service');
const entityMemory = require('../../../services/entityMemory.service');
const txn = require('../../../services/transaction.service');
const accountRepo = require('../../../repositories/account.repository');
const businessRepo = require('../../../repositories/business.repository');
const docRepo = require('../../../repositories/sourceDocument.repository');
const bookkeeper = require('../../../services/bookkeeper.service');

const BIZ = 'biz1';
const ACCOUNTS = [
  { _id: 'acc_rent', accountName: 'Rent Expense', accountType: 'Expense' },
  { _id: 'acc_cash', accountName: 'Cash', accountType: 'Asset' },
];

const parsedOk = (over = {}) => ({
  parsedData: { amount: 50000, description: 'Office rent for June', transactionType: 'expense', counterpartyName: 'ABC Properties', date: '2026-06-01', ...over },
  journalEntries: [
    { account: 'Rent Expense', entryType: 'debit', amount: 50000 },
    { account: 'Cash', entryType: 'credit', amount: 50000 },
  ],
  confidence: { overall: 0.8 },
});

beforeEach(() => {
  jest.clearAllMocks();
  accountRepo.findByBusiness.mockResolvedValue(ACCOUNTS);
  businessRepo.findById.mockResolvedValue({ country: 'PK' });
  docRepo.create.mockImplementation((d) => Promise.resolve({ _id: 'doc1', ...d }));
  docRepo.update.mockResolvedValue({});
  docRepo.findById.mockResolvedValue({ _id: 'doc1', status: 'proposed' });
  entityMemory.suggest.mockResolvedValue(null);
  actionRouter.propose.mockImplementation((a) => Promise.resolve({ _id: 'act1', status: 'queued', ...a }));
});

describe('resolveAccount', () => {
  it('matches an account by exact name (case-insensitive)', () => {
    expect(bookkeeper.resolveAccount(ACCOUNTS, 'cash')._id).toBe('acc_cash');
  });
  it('falls back to a contained-name match', () => {
    expect(bookkeeper.resolveAccount(ACCOUNTS, 'Rent')._id).toBe('acc_rent');
  });
  it('returns null when nothing matches', () => {
    expect(bookkeeper.resolveAccount(ACCOUNTS, 'Salaries')).toBeNull();
  });
});

describe('readIntoProposal', () => {
  const doc = { _id: 'doc1', businessId: BIZ, rawText: 'paid 50000 office rent', submittedBy: 'u1' };

  it('builds resolved journal lines and is ok when every account matches', async () => {
    parseTransaction.mockResolvedValue(parsedOk());
    const r = await bookkeeper.readIntoProposal(doc, ACCOUNTS, 'PK');
    expect(r.ok).toBe(true);
    expect(r.payload.journalLines).toEqual([
      { accountId: 'acc_rent', type: 'debit', amount: 50000 },
      { accountId: 'acc_cash', type: 'credit', amount: 50000 },
    ]);
    expect(r.confidence).toBeCloseTo(0.8);
  });

  it('boosts confidence and cites memory when the counterparty was booked before', async () => {
    parseTransaction.mockResolvedValue(parsedOk());
    entityMemory.suggest.mockResolvedValue({ value: { accountId: 'acc_rent' }, hits: 3 });
    const r = await bookkeeper.readIntoProposal(doc, ACCOUNTS, 'PK');
    expect(r.confidence).toBeCloseTo(0.9);
    expect(r.citations.join(' ')).toMatch(/booked ABC Properties before/);
  });

  it('caps confidence and is not ok when an account cannot be matched', async () => {
    parseTransaction.mockResolvedValue({
      parsedData: { amount: 9000, description: 'consulting', transactionType: 'expense' },
      journalEntries: [
        { account: 'Consulting Fees', entryType: 'debit', amount: 9000 },
        { account: 'Cash', entryType: 'credit', amount: 9000 },
      ],
      confidence: { overall: 0.85 },
    });
    const r = await bookkeeper.readIntoProposal(doc, ACCOUNTS, 'PK');
    expect(r.ok).toBe(false);
    expect(r.confidence).toBeLessThanOrEqual(0.3);
    expect(r.unresolved).toContain('Consulting Fees');
    expect(r.summary).toMatch(/couldn't match the account/i);
  });

  it('is not ok when no amount or lines are read', async () => {
    parseTransaction.mockResolvedValue({ parsedData: {}, journalEntries: [], confidence: { overall: 0 } });
    const r = await bookkeeper.readIntoProposal(doc, ACCOUNTS, 'PK');
    expect(r.ok).toBe(false);
  });
});

describe('ingest', () => {
  it('captures the document, proposes a post_journal action, and links them', async () => {
    parseTransaction.mockResolvedValue(parsedOk());
    const out = await bookkeeper.ingest({ businessId: BIZ, rawText: 'paid 50000 office rent to ABC', source: 'manual', submittedBy: 'u1' });

    expect(docRepo.create).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ, status: 'received' }));
    expect(actionRouter.propose).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'bookkeeping', type: 'post_journal', confidence: expect.any(Number),
      payload: expect.objectContaining({ journalLines: expect.any(Array), userId: 'u1' }),
    }));
    expect(docRepo.update).toHaveBeenCalledWith('doc1', expect.objectContaining({
      $set: expect.objectContaining({ status: 'proposed', proposedActionId: 'act1' }),
    }));
    expect(out.action._id).toBe('act1');
  });

  it('rejects empty input', async () => {
    await expect(bookkeeper.ingest({ businessId: BIZ, rawText: '   ' })).rejects.toThrow(/Nothing to read/i);
  });

  it('marks the document failed when the AI cannot read it', async () => {
    parseTransaction.mockResolvedValue({ parsedData: {}, journalEntries: [], confidence: { overall: 0 } });
    await bookkeeper.ingest({ businessId: BIZ, rawText: 'asdfghjkl' });
    expect(docRepo.update).toHaveBeenCalledWith('doc1', expect.objectContaining({
      $set: expect.objectContaining({ status: 'failed' }),
    }));
    expect(actionRouter.propose).not.toHaveBeenCalled();
  });
});

describe('executePostJournal (the ledger path)', () => {
  const action = {
    _id: 'act1', businessId: BIZ,
    payload: {
      businessId: BIZ, amount: 50000, description: 'rent', userId: 'u1', counterpartyName: 'ABC Properties',
      sourceDocumentId: 'doc1',
      journalLines: [{ accountId: 'acc_rent', type: 'debit', amount: 50000 }, { accountId: 'acc_cash', type: 'credit', amount: 50000 }],
    },
  };

  it('posts via createTransaction with an idempotency key and learns the counterparty', async () => {
    txn.createTransaction.mockResolvedValue({ _id: 'je1' });
    const r = await bookkeeper.executePostJournal(action);
    expect(txn.createTransaction).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'bk:act1' }), 'u1', null);
    expect(entityMemory.learn).toHaveBeenCalledWith(BIZ, 'counterparty_account', 'ABC Properties', { accountId: 'acc_rent' });
    expect(docRepo.update).toHaveBeenCalledWith('doc1', { $set: { status: 'posted', journalEntryId: 'je1' } });
    expect(r).toEqual({ journalEntryId: 'je1' });
  });

  it('refuses to post when no account was matched', async () => {
    const bad = { ...action, payload: { ...action.payload, journalLines: [{ accountId: null, type: 'debit', amount: 1 }] } };
    await expect(bookkeeper.executePostJournal(bad)).rejects.toThrow(/couldn’t match/i);
  });
});

describe('reversePostJournal', () => {
  it('reverses the posted ledger entry and marks the document dismissed', async () => {
    txn.reverseTransaction.mockResolvedValue({ _id: 'rev1' });
    const action = { businessId: BIZ, result: { journalEntryId: 'je1' }, payload: { userId: 'u1', sourceDocumentId: 'doc1' } };
    const r = await bookkeeper.reversePostJournal(action);
    expect(txn.reverseTransaction).toHaveBeenCalledWith('je1', BIZ, expect.any(Object), 'u1', null);
    expect(r).toEqual({ reversalId: 'rev1' });
  });

  it('throws when there is no ledger entry to reverse', async () => {
    await expect(bookkeeper.reversePostJournal({ businessId: BIZ, result: {}, payload: {} })).rejects.toThrow(/Nothing to reverse/i);
  });
});

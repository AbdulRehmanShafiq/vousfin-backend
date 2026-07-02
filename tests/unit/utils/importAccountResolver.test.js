'use strict';
const {
  matchByCode, matchBySynonym, inferAccountShape, nextAccountCode,
} = require('../../../utils/importAccountResolver');

const COA = [
  { _id: 'a1', accountCode: '1010', accountName: 'Cash at Bank',          accountType: 'Asset',     normalBalance: 'Debit' },
  { _id: 'a2', accountCode: '1110', accountName: 'Accounts Receivable',   accountType: 'Asset',     normalBalance: 'Debit' },
  { _id: 'a3', accountCode: '2110', accountName: 'Accounts Payable',      accountType: 'Liability', normalBalance: 'Credit' },
  { _id: 'a4', accountCode: '3110', accountName: 'Capital / Investment',  accountType: 'Equity',    normalBalance: 'Credit' },
  { _id: 'a5', accountCode: '3120', accountName: 'Distributions / Drawings', accountType: 'Equity', normalBalance: 'Debit' },
  { _id: 'a6', accountCode: '4110', accountName: 'Sales',                 accountType: 'Revenue',   normalBalance: 'Credit' },
  { _id: 'a7', accountCode: '6110', accountName: 'Rent',                  accountType: 'Expense',   normalBalance: 'Debit' },
];

describe('matchByCode', () => {
  it('resolves a bare account code', () => {
    expect(matchByCode(COA, '3110')._id).toBe('a4');
  });
  it('resolves a "code - name" cell', () => {
    expect(matchByCode(COA, '1110 - Accounts Receivable')._id).toBe('a2');
    expect(matchByCode(COA, '2110 Accounts Payable')._id).toBe('a3');
  });
  it('returns null for non-code inputs and unknown codes', () => {
    expect(matchByCode(COA, 'Owner Equity')).toBeNull();
    expect(matchByCode(COA, '9999')).toBeNull();
    expect(matchByCode(COA, '')).toBeNull();
  });
});

describe('matchBySynonym', () => {
  it('maps Owner Equity (the reported bug) to Capital / Investment', () => {
    expect(matchBySynonym(COA, 'Owner Equity')._id).toBe('a4');
    expect(matchBySynonym(COA, "Owner's Equity")._id).toBe('a4');
    expect(matchBySynonym(COA, 'owners equity')._id).toBe('a4');
    expect(matchBySynonym(COA, 'Owner Capital')._id).toBe('a4');
  });
  it('maps bookkeeping-vernacular names to the standard accounts', () => {
    expect(matchBySynonym(COA, 'Debtors')._id).toBe('a2');
    expect(matchBySynonym(COA, 'Trade Receivables')._id).toBe('a2');
    expect(matchBySynonym(COA, 'Creditors')._id).toBe('a3');
    expect(matchBySynonym(COA, 'Sales Revenue')._id).toBe('a6');
    expect(matchBySynonym(COA, 'Revenue')._id).toBe('a6');
    expect(matchBySynonym(COA, 'Owner Drawings')._id).toBe('a5');
    expect(matchBySynonym(COA, 'Bank')._id).toBe('a1');
    expect(matchBySynonym(COA, 'Rent Expense')._id).toBe('a7');
  });
  it('returns null when the synonym target account does not exist in this CoA', () => {
    const tiny = [{ _id: 'x', accountCode: '6110', accountName: 'Rent', accountType: 'Expense', normalBalance: 'Debit' }];
    expect(matchBySynonym(tiny, 'Owner Equity')).toBeNull();
  });
  it('returns null for names with no curated synonym', () => {
    expect(matchBySynonym(COA, 'Deep Sea Exploration Costs')).toBeNull();
  });
});

describe('inferAccountShape', () => {
  it('infers from deterministic name keywords first', () => {
    expect(inferAccountShape('Machine Repair Cost', {})).toEqual(
      expect.objectContaining({ accountType: 'Expense', normalBalance: 'Debit', accountSubtype: 'Expenses' }));
    expect(inferAccountShape('Equipment Loan Payable', {})).toEqual(
      expect.objectContaining({ accountType: 'Liability', normalBalance: 'Credit' }));
    expect(inferAccountShape('Founders Equity Pool', {})).toEqual(
      expect.objectContaining({ accountType: 'Equity', normalBalance: 'Credit', accountSubtype: 'Equity' }));
    expect(inferAccountShape('Consulting Income - Overseas', {})).toEqual(
      expect.objectContaining({ accountType: 'Revenue', normalBalance: 'Credit' }));
    expect(inferAccountShape('Warehouse Racking Equipment', {})).toEqual(
      expect.objectContaining({ accountType: 'Asset', normalBalance: 'Debit' }));
  });
  it('COGS-flavoured names land in Direct Cost (5xxx family)', () => {
    expect(inferAccountShape('Cost of Goods - Imported Stock', {})).toEqual(
      expect.objectContaining({ accountType: 'Expense', accountSubtype: 'Direct Cost' }));
  });
  it('falls back to the transaction-type + side matrix when keywords are silent', () => {
    expect(inferAccountShape('Zorbo', { side: 'credit', transactionType: 'Owner Investment' })).toEqual(
      expect.objectContaining({ accountType: 'Equity', normalBalance: 'Credit' }));
    expect(inferAccountShape('Zorbo', { side: 'debit', transactionType: 'Expense' })).toEqual(
      expect.objectContaining({ accountType: 'Expense', normalBalance: 'Debit' }));
    expect(inferAccountShape('Zorbo', { side: 'credit', transactionType: 'Income' })).toEqual(
      expect.objectContaining({ accountType: 'Revenue', normalBalance: 'Credit' }));
  });
  it('final fallback: debit→Expense, credit→Revenue', () => {
    expect(inferAccountShape('Zorbo', { side: 'debit' }).accountType).toBe('Expense');
    expect(inferAccountShape('Zorbo', { side: 'credit' }).accountType).toBe('Revenue');
  });
});

describe('nextAccountCode', () => {
  it('allocates the next free code in the type range', () => {
    expect(nextAccountCode(COA, 'Equity')).toBe('3130');       // after 3120
    expect(nextAccountCode(COA, 'Expense')).toBe('6120');      // after 6110 (operating range)
    expect(nextAccountCode(COA, 'Expense', 'Direct Cost')).toBe('5110'); // empty 5xxx range
  });
  it('starts a fresh range when the type has no accounts yet', () => {
    expect(nextAccountCode([], 'Revenue')).toBe('4110');
  });
  it('never collides with an existing code', () => {
    const withGap = [...COA, { accountCode: '3130', accountName: 'X', accountType: 'Equity' }];
    expect(nextAccountCode(withGap, 'Equity')).toBe('3140');
  });
});

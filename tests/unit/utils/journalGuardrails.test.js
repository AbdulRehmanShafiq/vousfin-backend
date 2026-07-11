'use strict';
const { checkJournalShape } = require('../../../utils/journalGuardrails');

describe('checkJournalShape', () => {
  test('valid purchase: DR Asset / CR Asset passes', () => {
    expect(checkJournalShape({
      transactionType: 'Inventory Purchase', debitAccountType: 'Asset', creditAccountType: 'Asset',
    })).toEqual({ ok: true, violations: [] });
  });

  test('purchase debiting Revenue is a violation', () => {
    const r = checkJournalShape({
      transactionType: 'Cash Purchase', debitAccountType: 'Revenue', creditAccountType: 'Asset',
    });
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBe(1);
  });

  test('purchase crediting Revenue is a violation', () => {
    const r = checkJournalShape({
      transactionType: 'Expense', debitAccountType: 'Expense', creditAccountType: 'Revenue',
    });
    expect(r.ok).toBe(false);
  });

  test('credit purchase crediting a Liability (AP) passes', () => {
    expect(checkJournalShape({
      transactionType: 'Credit Purchase', debitAccountType: 'Expense', creditAccountType: 'Liability',
    }).ok).toBe(true);
  });

  test('valid sale: DR Asset / CR Revenue passes', () => {
    expect(checkJournalShape({
      transactionType: 'Inventory Sale', debitAccountType: 'Asset', creditAccountType: 'Revenue',
    }).ok).toBe(true);
  });

  test('sale crediting an Expense account is a violation', () => {
    expect(checkJournalShape({
      transactionType: 'Cash Sale', debitAccountType: 'Asset', creditAccountType: 'Expense',
    }).ok).toBe(false);
  });

  test('unknown transaction types have no rule → ok', () => {
    expect(checkJournalShape({
      transactionType: 'Journal Entry', debitAccountType: 'Equity', creditAccountType: 'Equity',
    }).ok).toBe(true);
  });

  test('missing account types → ok (nothing to judge)', () => {
    expect(checkJournalShape({ transactionType: 'Expense', debitAccountType: null, creditAccountType: null }).ok).toBe(true);
  });
});

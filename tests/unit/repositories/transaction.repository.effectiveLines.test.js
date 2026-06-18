/**
 * tests/unit/repositories/transaction.repository.effectiveLines.test.js
 *
 * Guards roadmap §A1 at the source: the Income Statement, Trial Balance and
 * Balance Sheet must all normalise a journal entry into the SAME effective lines,
 * so they can never disagree about an entry whose COGS / tax legs live only in
 * `journalLines`. We assert the shared stage is exported and shaped correctly
 * (it must prefer journalLines, and otherwise synthesise the top-level pair).
 */
'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const transactionRepository = require('../../../repositories/transaction.repository');

describe('EFFECTIVE_LINES_STAGE — shared line normalisation', () => {
  test('is exported as a Mongo $addFields stage', () => {
    const stage = transactionRepository.EFFECTIVE_LINES_STAGE;
    expect(stage).toBeDefined();
    expect(stage.$addFields).toBeDefined();
    expect(stage.$addFields.effectiveLines.$cond).toBeDefined();
  });

  test('prefers explicit journalLines when present, else synthesises the 2-account pair', () => {
    const cond = transactionRepository.EFFECTIVE_LINES_STAGE.$addFields.effectiveLines.$cond;

    // `if` tests journalLines size > 0
    expect(JSON.stringify(cond.if)).toContain('journalLines');
    // `then` uses the explicit lines
    expect(cond.then).toBe('$journalLines');
    // `else` synthesises debit + credit in the REPORTING (base) currency, so a
    // foreign-currency entry hits the ledger at baseCurrencyAmount, not the raw
    // foreign amount (falls back to amount when baseCurrencyAmount is null).
    expect(cond.else).toEqual([
      { accountId: '$debitAccountId',  type: 'debit',  amount: { $ifNull: ['$baseCurrencyAmount', '$amount'] } },
      { accountId: '$creditAccountId', type: 'credit', amount: { $ifNull: ['$baseCurrencyAmount', '$amount'] } },
    ]);
  });
});

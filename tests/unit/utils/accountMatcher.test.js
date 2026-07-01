// tests/unit/utils/accountMatcher.test.js
'use strict';
const { matchAccountByName } = require('../../../utils/accountMatcher');

function acc(id, accountName) {
  return { _id: id, accountName };
}

const ACCOUNTS = [
  acc('a1', 'Cash at Bank'),
  acc('a2', 'Accounts Receivable'),
  acc('a3', 'Rent'),
  acc('a4', 'Rent — Equipment & Machinery'),
  acc('a5', 'Professional / Legal Fees'),
  acc('a6', 'Office Supplies & Stationery'),
];

describe('matchAccountByName', () => {
  test('exact case-insensitive match → confidence 1.0, matchType exact', () => {
    const r = matchAccountByName(ACCOUNTS, 'cash at bank');
    expect(r.account._id).toBe('a1');
    expect(r.confidence).toBe(1.0);
    expect(r.matchType).toBe('exact');
  });

  test('single unambiguous substring match → confidence 0.75, matchType fuzzy', () => {
    const r = matchAccountByName(ACCOUNTS, 'Receivable');
    expect(r.account._id).toBe('a2');
    expect(r.confidence).toBe(0.75);
    expect(r.matchType).toBe('fuzzy');
  });

  test('ambiguous substring match (multiple accounts contain the name, none exactly) → matchType ambiguous, confidence 0.5, picks the tightest fit not the first', () => {
    // "Rent" is a substring of two accounts but an exact match of neither.
    // The bug being fixed: old code returned partials[0] in document order regardless of fit.
    const withAmbiguity = [
      acc('a7', 'Rent — Equipment & Machinery'), // longer name comes FIRST in the array
      acc('a8', 'Rent Office'),
    ];
    const r = matchAccountByName(withAmbiguity, 'Rent');
    expect(r.matchType).toBe('ambiguous');
    expect(r.confidence).toBe(0.5);
    // a8's name is much closer in length to "Rent" — tightest fit wins, not document order.
    expect(r.account._id).toBe('a8');
  });

  test('word-overlap fuzzy match (no substring hit) → matchType fuzzy, confidence scaled by overlap', () => {
    const r = matchAccountByName(ACCOUNTS, 'Legal Professional Fees');
    expect(r.account._id).toBe('a5');
    expect(r.matchType).toBe('fuzzy');
    expect(r.confidence).toBeGreaterThan(0.4);
    expect(r.confidence).toBeLessThanOrEqual(0.7);
  });

  test('no match at all → { account: null, confidence: 0, matchType: none }', () => {
    const r = matchAccountByName(ACCOUNTS, 'Totally Unrelated Xyzzy');
    expect(r.account).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.matchType).toBe('none');
  });

  test('does not false-positive on short common words as substrings (e.g. "at" inside "totally")', () => {
    // Regression lock: a naive bidirectional substring check on unfiltered short
    // words would match "totally" to "Cash at Bank" via the "at" substring.
    const r = matchAccountByName(ACCOUNTS, 'Totally Unrelated Statement');
    expect(r.matchType).toBe('none');
  });

  test('empty/missing name → no match, does not throw', () => {
    expect(matchAccountByName(ACCOUNTS, '')).toEqual({ account: null, confidence: 0, matchType: 'none' });
    expect(matchAccountByName(ACCOUNTS, null)).toEqual({ account: null, confidence: 0, matchType: 'none' });
  });

  test('empty accounts list → no match, does not throw', () => {
    expect(matchAccountByName([], 'Cash at Bank')).toEqual({ account: null, confidence: 0, matchType: 'none' });
  });
});

// tests/unit/utils/mt940Parser.test.js
// TDD — Phase 8 FR-01.5 MT940 parser
'use strict';

const { parseMT940 } = require('../../../utils/mt940Parser.util');

// Minimal MT940 fixture with one transaction
const MT940_BASIC = `:20:STMT20240315
:25:PK123456789
:28C:00001/001
:60F:C240315PKR1000000,00
:61:2403150315C25000,00NTRFCUST001
:86:Customer payment received
:61:2403200320D5000,00NCHQSUP001
:86:Supplier payment
:62F:C240320PKR1020000,00`;

// Another fixture with debit (D) and credit (C)
const MT940_DEBIT_CREDIT = `:20:REF001
:25:ACC99887766
:28C:00001/001
:60F:C240101USD50000,00
:61:2401010101C10000,00NTRFINV001
:86:Invoice payment
:62F:C240101USD60000,00`;

describe('parseMT940', () => {
  describe('basic parsing', () => {
    it('extracts account number from :25: tag', () => {
      const result = parseMT940(MT940_BASIC);
      expect(result.accountId).toBe('PK123456789');
    });

    it('extracts currency from :60F: tag', () => {
      const result = parseMT940(MT940_BASIC);
      expect(result.currency).toBe('PKR');
    });

    it('parses two transactions from MT940', () => {
      const result = parseMT940(MT940_BASIC);
      expect(result.transactions).toHaveLength(2);
    });

    it('parses credit transaction (C) as positive amount', () => {
      const result = parseMT940(MT940_BASIC);
      const credit = result.transactions.find(t => t.amount > 0);
      expect(credit).toBeDefined();
      expect(credit.amount).toBe(25000);
    });

    it('parses debit transaction (D) as negative amount', () => {
      const result = parseMT940(MT940_BASIC);
      const debit = result.transactions.find(t => t.amount < 0);
      expect(debit).toBeDefined();
      expect(debit.amount).toBe(-5000);
    });

    it('parses date from :61: value date (YYMMDD → 20YY-MM-DD)', () => {
      const result = parseMT940(MT940_BASIC);
      const first = result.transactions[0];
      expect(first.date).toBeInstanceOf(Date);
      expect(first.date.getFullYear()).toBe(2024);
      expect(first.date.getMonth()).toBe(2); // March = 2 (0-indexed)
      expect(first.date.getDate()).toBe(15);
    });

    it('extracts description from :86: narrative', () => {
      const result = parseMT940(MT940_BASIC);
      expect(result.transactions[0].description).toMatch(/Customer payment/i);
    });

    it('replaces comma decimal separator with dot', () => {
      // Amount 25000,00 should parse to 25000
      const result = parseMT940(MT940_BASIC);
      expect(typeof result.transactions[0].amount).toBe('number');
      expect(result.transactions[0].amount).toBe(25000);
    });
  });

  describe('single credit transaction', () => {
    it('parses credit transaction correctly', () => {
      const result = parseMT940(MT940_DEBIT_CREDIT);
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].amount).toBe(10000);
      expect(result.accountId).toBe('ACC99887766');
    });
  });

  describe('error handling', () => {
    it('returns empty transactions on empty string', () => {
      const result = parseMT940('');
      expect(result.transactions).toEqual([]);
    });

    it('returns empty transactions on malformed input', () => {
      const result = parseMT940('this is not MT940 format at all');
      expect(result.transactions).toEqual([]);
    });

    it('does not throw on null input', () => {
      expect(() => parseMT940(null)).not.toThrow();
    });

    it('returns empty transactions on partial/truncated data', () => {
      const result = parseMT940(':20:REF\n:25:');
      expect(result.transactions).toEqual([]);
    });
  });
});

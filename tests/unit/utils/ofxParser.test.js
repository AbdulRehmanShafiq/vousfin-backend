// tests/unit/utils/ofxParser.test.js
// TDD — Phase 8 FR-01.5 OFX parser
'use strict';

const { parseOFX } = require('../../../utils/ofxParser.util');

// Minimal OFX 1.x SGML fixture (no closing tags)
const OFX_1X = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<CURDEF>PKR
<BANKACCTFROM>
<ACCTID>12345678
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240315
<TRNAMT>-5000.00
<FITID>TXN001
<MEMO>Salary Payment
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240320120000
<TRNAMT>25000.00
<FITID>TXN002
<NAME>Customer Receipt
</STMTTRN>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

// Minimal OFX 2.x XML fixture
const OFX_2X = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="211"?>
<OFX>
  <BANKMSGSRSV1>
    <STMTTRNRS>
      <STMTRS>
        <CURDEF>USD</CURDEF>
        <BANKACCTFROM>
          <ACCTID>ACC9999</ACCTID>
        </BANKACCTFROM>
        <STMTTRN>
          <DTPOSTED>20240401</DTPOSTED>
          <TRNAMT>10000.00</TRNAMT>
          <FITID>XML001</FITID>
          <MEMO>Test Payment</MEMO>
        </STMTTRN>
      </STMTRS>
    </STMTTRNRS>
  </BANKMSGSRSV1>
</OFX>`;

describe('parseOFX', () => {
  describe('OFX 1.x SGML format', () => {
    it('parses two transactions from OFX 1.x', () => {
      const result = parseOFX(OFX_1X);
      expect(result.transactions).toHaveLength(2);
    });

    it('extracts accountId from BANKACCTFROM', () => {
      const result = parseOFX(OFX_1X);
      expect(result.accountId).toBe('12345678');
    });

    it('extracts currency from CURDEF', () => {
      const result = parseOFX(OFX_1X);
      expect(result.currency).toBe('PKR');
    });

    it('parses DTPOSTED date (YYYYMMDD → Date)', () => {
      const result = parseOFX(OFX_1X);
      const t = result.transactions[0];
      expect(t.date).toBeInstanceOf(Date);
      expect(t.date.getFullYear()).toBe(2024);
      expect(t.date.getMonth()).toBe(2); // March = 2 (0-indexed)
      expect(t.date.getDate()).toBe(15);
    });

    it('parses DTPOSTED with time component (YYYYMMDDHHMMSS)', () => {
      const result = parseOFX(OFX_1X);
      const t = result.transactions[1];
      expect(t.date).toBeInstanceOf(Date);
      expect(t.date.getFullYear()).toBe(2024);
      expect(t.date.getMonth()).toBe(2);
      expect(t.date.getDate()).toBe(20);
    });

    it('parses amount as number', () => {
      const result = parseOFX(OFX_1X);
      expect(result.transactions[0].amount).toBe(-5000);
      expect(result.transactions[1].amount).toBe(25000);
    });

    it('extracts description from MEMO', () => {
      const result = parseOFX(OFX_1X);
      expect(result.transactions[0].description).toMatch(/Salary/i);
    });

    it('falls back to NAME when MEMO not present', () => {
      const result = parseOFX(OFX_1X);
      expect(result.transactions[1].description).toMatch(/Customer/i);
    });

    it('extracts fitid', () => {
      const result = parseOFX(OFX_1X);
      expect(result.transactions[0].fitid).toBe('TXN001');
      expect(result.transactions[1].fitid).toBe('TXN002');
    });
  });

  describe('OFX 2.x XML format', () => {
    it('parses XML OFX (starts with <?xml)', () => {
      const result = parseOFX(OFX_2X);
      expect(result.transactions).toHaveLength(1);
      expect(result.accountId).toBe('ACC9999');
      expect(result.currency).toBe('USD');
      expect(result.transactions[0].amount).toBe(10000);
    });
  });

  describe('error handling', () => {
    it('returns empty transactions on empty string', () => {
      const result = parseOFX('');
      expect(result.transactions).toEqual([]);
    });

    it('returns empty transactions on garbage input', () => {
      const result = parseOFX('not ofx at all <<<>>>');;
      expect(result.transactions).toEqual([]);
    });

    it('does not throw on null input', () => {
      expect(() => parseOFX(null)).not.toThrow();
    });
  });
});

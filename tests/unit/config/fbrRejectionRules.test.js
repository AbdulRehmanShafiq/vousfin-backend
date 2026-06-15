'use strict';

const { FBR_REJECTION_RULES, rulesFor } = require('../../../config/fbrRejectionRules');
const byCode = (code) => FBR_REJECTION_RULES.find(r => r.code === code);

describe('fbrRejectionRules — catalog integrity', () => {
  it('every rule has the auditable shape with a fix', () => {
    expect(FBR_REJECTION_RULES.length).toBeGreaterThanOrEqual(7);
    for (const r of FBR_REJECTION_RULES) {
      expect(typeof r.code).toBe('string');
      expect(typeof r.returnType).toBe('string');     // specific type or '*'
      expect(r.message).toBeTruthy();
      expect(r.fix).toBeTruthy();                      // AC: each error tells the user how to fix it
      expect(['error', 'warning']).toContain(r.severity);
      expect(typeof r.check).toBe('function');
    }
  });

  it('rulesFor narrows to a return type + the universal rules', () => {
    const gst = rulesFor('GST-01').map(r => r.code);
    expect(gst).toContain('NTN_MISSING');             // universal
    expect(gst).toContain('OUTPUT_LT_ANNEX');         // GST-specific
    expect(gst).not.toContain('WHT_VENDOR_CNIC_MISSING');
  });
});

describe('NTN rules', () => {
  it('flags a missing NTN', () => {
    expect(byCode('NTN_MISSING').check({ businessNtn: '' })).toBe(true);
    expect(byCode('NTN_MISSING').check({ businessNtn: '1234567' })).toBe(false);
  });
  it('flags a malformed NTN but accepts 7/13 digit forms', () => {
    const r = byCode('NTN_FORMAT');
    expect(r.check({ businessNtn: 'ABC' })).toBe(true);
    expect(r.check({ businessNtn: '1234567' })).toBe(false);
    expect(r.check({ businessNtn: '1234567890123' })).toBe(false);
    expect(r.check({ businessNtn: '' })).toBe(false);   // absence is NTN_MISSING's job
  });
});

describe('GST-01 annex tie-out', () => {
  const data = (outputTax, cLines) => ({ data: { fields: { outputTax, inputTax: 0, netPayable: outputTax }, annexes: { A: [], C: cLines } } });
  it('flags header output tax that does not equal Annex-C', () => {
    expect(byCode('OUTPUT_LT_ANNEX').check(data(2000, [{ salesTax: 0 }]))).toBe(true);
  });
  it('passes when header equals Annex-C total', () => {
    expect(byCode('OUTPUT_LT_ANNEX').check(data(1700, [{ salesTax: 1700 }]))).toBe(false);
  });
});

describe('WHT-165 vendor identity', () => {
  it('flags a 165 line without an NTN/CNIC', () => {
    const r = byCode('WHT_VENDOR_CNIC_MISSING');
    expect(r.check({ data: { lines: [{ vendorName: 'A', taxId: 'NTN-1' }, { vendorName: 'B', taxId: null }] } })).toBe(true);
    expect(r.check({ data: { lines: [{ vendorName: 'A', taxId: 'NTN-1' }] } })).toBe(false);
  });
});

describe('period closure + refund election', () => {
  it('flags unposted transactions in the period', () => {
    expect(byCode('PERIOD_NOT_CLOSED').check({ unpostedCount: 3 })).toBe(true);
    expect(byCode('PERIOD_NOT_CLOSED').check({ unpostedCount: 0 })).toBe(false);
  });
  it('warns on a negative liability without a refund election', () => {
    const r = byCode('NEGATIVE_LIABILITY_NO_REFUND_FLAG');
    expect(r.severity).toBe('warning');
    expect(r.check({ data: { fields: { netPayable: -500 }, refundClaim: false } })).toBe(true);
    expect(r.check({ data: { fields: { netPayable: -500 }, refundClaim: true } })).toBe(false);
    expect(r.check({ data: { fields: { netPayable: 500 } } })).toBe(false);
  });
});

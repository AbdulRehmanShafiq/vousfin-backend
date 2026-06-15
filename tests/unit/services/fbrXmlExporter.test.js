'use strict';

const { toXML } = require('../../../services/fbr/fbrXmlExporter');

const gstDoc = {
  returnType: 'GST-01',
  period: { year: 2026, month: 6 },
  data: {
    fields: { totalTaxableSales: 12000, outputTax: 2071997.47, totalTaxablePurchases: 0, inputTax: 0, netPayable: 2071997.47 },
    annexes: {
      A: [],
      C: [
        { serial: 1, date: new Date(2026, 5, 3), description: 'Sale to A & B Co', value: 10000, taxRate: 17, salesTax: 1700 },
        { serial: 2, date: new Date(2026, 5, 9), description: 'Sale 2', value: 2000, taxRate: 17, salesTax: 340 },
      ],
    },
  },
};

describe('fbrXmlExporter.toXML', () => {
  it('emits a well-formed GST-01 document with header totals', () => {
    const xml = toXML(gstDoc, '1234567');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<GSTReturn>');
    expect(xml).toContain('<NTN>1234567</NTN>');
    expect(xml).toContain('<OutputTax>2071997.47</OutputTax>');
    expect(xml).toContain('<NetPayable>2071997.47</NetPayable>');
  });

  it('emits one Annex-C Item per taxable sale line', () => {
    const xml = toXML(gstDoc, '1234567');
    const items = xml.match(/<Item>/g) || [];
    expect(items).toHaveLength(2);
  });

  it('escapes XML-special characters in text', () => {
    const xml = toXML(gstDoc, '1234567');
    expect(xml).toContain('Sale to A &amp; B Co');
    expect(xml).not.toContain('A & B Co');
  });

  it('emits a WHT-165 document with one Line per vendor', () => {
    const xml = toXML({
      returnType: 'WHT-165', period: { year: 2026, month: 6 },
      data: { fields: { totalWithheld: 6000 }, lines: [
        { serial: 1, vendorName: 'Acme', taxId: 'NTN-1', section: '153', grossAmount: 100000, taxWithheld: 4000 },
        { serial: 2, vendorName: 'Beta', taxId: 'NTN-2', section: '153', grossAmount: 50000,  taxWithheld: 2000 },
      ] },
    }, '1234567');
    expect(xml).toContain('<WHTStatement>');
    expect((xml.match(/<Line>/g) || [])).toHaveLength(2);
  });

  it('emits an income-tax return document', () => {
    const xml = toXML({
      returnType: 'IT-RETURN', period: { year: 2026 },
      data: { fields: { taxableIncome: 1000000, taxChargeable: 290000, balancePayable: 190000 } },
    }, '1234567');
    expect(xml).toContain('<IncomeTaxReturn>');
    expect(xml).toContain('<TaxChargeable>290000</TaxChargeable>');
  });
});

'use strict';
jest.mock('../../../models/PayrollRun.model', () => ({ find: jest.fn() }));
const PayrollRun = require('../../../models/PayrollRun.model');
const tax = require('../../../services/payrollTax.service');

const BIZ = 'biz1';
const lean = (v) => ({ lean: () => Promise.resolve(v) });

beforeEach(() => jest.clearAllMocks());

describe('generateSalaryCertificate', () => {
  it('aggregates the employee’s posted-run lines across the tax year', async () => {
    PayrollRun.find.mockReturnValue(lean([
      { period: '2025-07', status: 'posted', lines: [{ employeeId: 'e1', employeeName: 'Ali', gross: 100000, taxableIncome: 95000, incomeTax: 1000 }] },
      { period: '2025-08', status: 'paid',   lines: [{ employeeId: 'e1', employeeName: 'Ali', gross: 100000, taxableIncome: 95000, incomeTax: 1000 }] },
      { period: '2025-08', status: 'paid',   lines: [{ employeeId: 'e2', employeeName: 'Sara', gross: 50000, taxableIncome: 50000, incomeTax: 0 }] },
    ]));
    const cert = await tax.generateSalaryCertificate(BIZ, 'e1', '2025-26');
    expect(cert.employeeName).toBe('Ali');
    expect(cert.totals).toMatchObject({ gross: 200000, taxableIncome: 190000, taxWithheld: 2000 });
    expect(cert.months).toHaveLength(2);
  });

  it('throws when the employee has no posted lines in the year', async () => {
    PayrollRun.find.mockReturnValue(lean([]));
    await expect(tax.generateSalaryCertificate(BIZ, 'eX', '2025-26')).rejects.toThrow(/no payroll/i);
  });
});

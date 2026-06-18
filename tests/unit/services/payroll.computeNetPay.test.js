'use strict';
const { computeNetPay } = require('../../../services/payroll.service');

const YEAR = '2025-26';
// basic 100k + HRA 40k + medical 10k = gross 150k; medical exempt up to 10% of basic (10k)
const structure = {
  basic: 100000,
  allowances: { houseRent: 40000, medical: 10000, conveyance: 0, special: 0, other: 0 },
  taxExempt: { medicalCapPctOfBasic: 10 },
  eobi: { enabled: true, employeeAmount: 250, employerAmount: 1500 },
  providentFund: { enabled: true, employeePctOfBasic: 5, employerPctOfBasic: 5 },
  recurringDeductions: [{ label: 'SESSI', amount: 500 }],
};

describe('computeNetPay', () => {
  it('computes a full gross-to-net line with employer split', () => {
    const line = computeNetPay(structure, { taxYear: YEAR }, {});
    expect(line.gross).toBe(150000);
    expect(line.taxableIncome).toBe(140000);          // 150000 - 10000 medical exempt
    // annual 140000*12 = 1,680,000 → 6000 + 11% of (1,680,000-1,200,000)=52,800 → 58,800/12 = 4900
    expect(line.incomeTax).toBe(4900);
    expect(line.eobiEmployee).toBe(250);
    expect(line.eobiEmployer).toBe(1500);
    expect(line.pfEmployee).toBe(5000);               // 5% of basic
    expect(line.pfEmployer).toBe(5000);
    expect(line.otherDeductionsTotal).toBe(500);      // SESSI
    // net = 150000 - 4900 - 250 - 5000 - 500
    expect(line.netPay).toBe(139350);
  });

  it('adds per-run additions to gross and deductions to other', () => {
    const line = computeNetPay(structure, { taxYear: YEAR }, {
      additions: [{ label: 'Overtime', amount: 10000 }],
      deductions: [{ label: 'Loan', amount: 2000 }],
    });
    expect(line.gross).toBe(160000);
    expect(line.additions).toEqual([{ label: 'Overtime', amount: 10000 }]);
    expect(line.otherDeductionsTotal).toBe(2500);     // SESSI 500 + loan 2000
  });

  it('treats a disabled EOBI/PF structure as zero', () => {
    const s = { ...structure, eobi: { enabled: false }, providentFund: { enabled: false }, recurringDeductions: [] };
    const line = computeNetPay(s, { taxYear: YEAR }, {});
    expect(line.eobiEmployee).toBe(0);
    expect(line.pfEmployee).toBe(0);
    expect(line.netPay).toBe(line.gross - line.incomeTax);
  });
});

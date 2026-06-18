'use strict';
jest.mock('../../../repositories/employee.repository', () => ({ findActive: jest.fn() }));
jest.mock('../../../repositories/payrollRun.repository', () => ({ findActiveByPeriod: jest.fn(), create: jest.fn() }));
jest.mock('../../../models/Employee.model', () => ({ resolveStructure: jest.fn() }));

const employeeRepo = require('../../../repositories/employee.repository');
const runRepo = require('../../../repositories/payrollRun.repository');
const Employee = require('../../../models/Employee.model');
const payroll = require('../../../services/payroll.service');

const BIZ = 'biz1';
const STRUCT = {
  basic: 100000, allowances: { houseRent: 0, medical: 0, conveyance: 0, special: 0, other: 0 },
  taxExempt: { medicalCapPctOfBasic: 0 },
  eobi: { enabled: false }, providentFund: { enabled: false }, recurringDeductions: [],
};
const EMP = { _id: 'e1', code: 'E001', fullName: 'Ali', department: 'cc1', salaryStructure: [STRUCT] };

beforeEach(() => {
  jest.clearAllMocks();
  employeeRepo.findActive.mockResolvedValue([EMP]);
  Employee.resolveStructure.mockReturnValue(STRUCT);
  runRepo.findActiveByPeriod.mockResolvedValue(null);
  runRepo.create.mockImplementation((doc) => Promise.resolve({ _id: 'run1', ...doc }));
});

describe('processRun', () => {
  it('builds a draft run with one line per active employee and rolled-up totals', async () => {
    const run = await payroll.processRun(BIZ, '2026-06', { adjustments: {} }, { id: 'u1' });
    expect(run.lines).toHaveLength(1);
    expect(run.lines[0]).toMatchObject({ employeeCode: 'E001', gross: 100000 });
    expect(run.totals.gross).toBe(100000);
    expect(run.totals.netPay).toBe(run.lines[0].netPay);
    expect(run.status).toBe('processed');
  });

  it('refuses to reprocess a period that is already posted', async () => {
    runRepo.findActiveByPeriod.mockResolvedValue({ _id: 'run1', status: 'posted' });
    await expect(payroll.processRun(BIZ, '2026-06', { adjustments: {} }, { id: 'u1' }))
      .rejects.toThrow(/already posted/i);
  });

  it('applies per-employee adjustments by employee id', async () => {
    const run = await payroll.processRun(BIZ, '2026-06', {
      adjustments: { e1: { additions: [{ label: 'Bonus', amount: 5000 }] } },
    }, { id: 'u1' });
    expect(run.lines[0].gross).toBe(105000);
  });
});

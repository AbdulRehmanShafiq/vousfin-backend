'use strict';
// Real services, mocked persistence — proves process → post (balanced, register==GL) → reverse.
jest.mock('../../repositories/employee.repository', () => ({ findActive: jest.fn(), findByBusiness: jest.fn() }));
jest.mock('../../repositories/payrollRun.repository', () => ({ findActiveByPeriod: jest.fn(), findOwned: jest.fn(), create: jest.fn() }));
jest.mock('../../repositories/account.repository', () => ({ findByCode: jest.fn() }));
jest.mock('../../models/Employee.model', () => ({ resolveStructure: jest.fn() }));
jest.mock('../../services/transaction.service', () => ({ createTransaction: jest.fn(), reverseTransaction: jest.fn() }));

const employeeRepo = require('../../repositories/employee.repository');
const runRepo = require('../../repositories/payrollRun.repository');
const accountRepo = require('../../repositories/account.repository');
const Employee = require('../../models/Employee.model');
const txService = require('../../services/transaction.service');
const payroll = require('../../services/payroll.service');

const BIZ = 'biz1';
const STRUCT = {
  basic: 100000, allowances: { houseRent: 40000, medical: 10000, conveyance: 0, special: 0, other: 0 },
  taxExempt: { medicalCapPctOfBasic: 10 },
  eobi: { enabled: true, employeeAmount: 250, employerAmount: 1500 },
  providentFund: { enabled: true, employeePctOfBasic: 5, employerPctOfBasic: 5 },
  recurringDeductions: [{ label: 'SESSI', amount: 500 }],
};

beforeEach(() => {
  jest.clearAllMocks();
  employeeRepo.findActive.mockResolvedValue([{ _id: 'e1', code: 'E1', fullName: 'Ali', department: 'cc1', salaryStructure: [STRUCT] }]);
  Employee.resolveStructure.mockReturnValue(STRUCT);
  accountRepo.findByCode.mockImplementation((b, code) => Promise.resolve({ _id: `acc-${code}` }));
  let n = 0; txService.createTransaction.mockImplementation(() => Promise.resolve({ _id: `je${++n}` }));
  txService.reverseTransaction.mockImplementation(() => Promise.resolve({ _id: 'rev' }));
});

it('process → post keeps GL totals equal to the payroll register', async () => {
  let stored;
  runRepo.findActiveByPeriod.mockResolvedValue(null);
  runRepo.create.mockImplementation((doc) => {
    stored = { ...doc, _id: 'run1', postedJournalEntryIds: [], save: jest.fn().mockImplementation(function () { return Promise.resolve(this); }) };
    return Promise.resolve(stored);
  });
  const processed = await payroll.processRun(BIZ, '2026-06', { adjustments: {} }, { id: 'u1' });
  expect(processed.totals.gross).toBe(150000);

  runRepo.findOwned.mockResolvedValue(stored);
  const posted = await payroll.postToGL(BIZ, 'run1', { id: 'u1' });

  const pairs = txService.createTransaction.mock.calls.map((c) => c[0]);
  const drTo6180 = pairs.filter((p) => p.debitAccountId === 'acc-6180').reduce((s, p) => s + p.amount, 0);
  expect(drTo6180).toBe(processed.totals.gross);                 // wages expense == register gross
  const creditToNet = pairs.filter((p) => p.creditAccountId === 'acc-2140').reduce((s, p) => s + p.amount, 0);
  expect(creditToNet).toBe(processed.totals.netPay);            // wages payable == register net
  expect(posted.status).toBe('posted');
});

it('reverse undoes every posted entry', async () => {
  const run = { _id: 'run1', businessId: BIZ, period: '2026-06', status: 'posted',
    postedJournalEntryIds: ['je1', 'je2', 'je3'], reversalJournalEntryIds: [], totals: { netPay: 1 },
    save: jest.fn().mockImplementation(function () { return Promise.resolve(this); }) };
  runRepo.findOwned.mockResolvedValue(run);
  const r = await payroll.reverseRun(BIZ, 'run1', { id: 'u1' });
  expect(txService.reverseTransaction).toHaveBeenCalledTimes(3);
  expect(r.status).toBe('reversed');
});

it('a 500-employee single-cost-centre run posts a bounded number of entries', async () => {
  const emps = Array.from({ length: 500 }, (_, i) => ({ _id: `e${i}`, code: `E${i}`, fullName: `Emp${i}`, department: 'cc1', salaryStructure: [STRUCT] }));
  employeeRepo.findActive.mockResolvedValue(emps);
  let stored;
  runRepo.findActiveByPeriod.mockResolvedValue(null);
  runRepo.create.mockImplementation((doc) => { stored = { ...doc, _id: 'runP', postedJournalEntryIds: [], save: jest.fn().mockImplementation(function () { return Promise.resolve(this); }) }; return Promise.resolve(stored); });
  await payroll.processRun(BIZ, '2026-06', { adjustments: {} }, { id: 'u1' });
  runRepo.findOwned.mockResolvedValue(stored);
  await payroll.postToGL(BIZ, 'runP', { id: 'u1' });
  // one cost-centre → at most 7 aggregated pairs, regardless of headcount
  expect(txService.createTransaction.mock.calls.length).toBeLessThanOrEqual(7);
});

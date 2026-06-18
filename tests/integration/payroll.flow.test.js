'use strict';
// Real services, mocked persistence — proves process → post (ONE balanced compound
// entry whose lines equal the payroll register) → reverse.
jest.mock('../../repositories/employee.repository', () => ({ findActive: jest.fn(), findByBusiness: jest.fn() }));
jest.mock('../../repositories/payrollRun.repository', () => ({ findActiveByPeriod: jest.fn(), findOwned: jest.fn(), create: jest.fn() }));
jest.mock('../../repositories/account.repository', () => ({ findByCode: jest.fn() }));
jest.mock('../../models/Employee.model', () => ({ resolveStructure: jest.fn() }));
jest.mock('../../services/ledgerPosting.service', () => ({ postCompoundJournal: jest.fn() }));
jest.mock('../../services/transaction.service', () => ({ reverseTransaction: jest.fn() }));

const employeeRepo = require('../../repositories/employee.repository');
const runRepo = require('../../repositories/payrollRun.repository');
const accountRepo = require('../../repositories/account.repository');
const Employee = require('../../models/Employee.model');
const ledgerPosting = require('../../services/ledgerPosting.service');
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
  ledgerPosting.postCompoundJournal.mockResolvedValue({ _id: 'je1' });
  txService.reverseTransaction.mockImplementation(() => Promise.resolve({ _id: 'rev' }));
});

it('process → post emits ONE balanced compound entry equal to the register', async () => {
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

  expect(ledgerPosting.postCompoundJournal).toHaveBeenCalledTimes(1);
  const { lines } = ledgerPosting.postCompoundJournal.mock.calls[0][0];
  const sum = (t) => lines.filter(l => l.type === t).reduce((s, l) => s + l.amount, 0);
  expect(sum('debit')).toBe(sum('credit'));                                   // balanced
  const wages = lines.filter(l => l.accountId === 'acc-6180').reduce((s, l) => s + l.amount, 0);
  expect(wages).toBe(processed.totals.gross);                                 // wages expense == register gross
  expect(lines.find(l => l.accountId === 'acc-2140').amount).toBe(processed.totals.netPay); // payable == register net
  expect(posted.status).toBe('posted');
  expect(posted.postedJournalEntryIds).toEqual(['je1']);
});

it('reverse undoes the posted entry', async () => {
  const run = { _id: 'run1', businessId: BIZ, period: '2026-06', status: 'posted',
    postedJournalEntryIds: ['je1'], reversalJournalEntryIds: [], totals: { netPay: 1 },
    save: jest.fn().mockImplementation(function () { return Promise.resolve(this); }) };
  runRepo.findOwned.mockResolvedValue(run);
  const r = await payroll.reverseRun(BIZ, 'run1', { id: 'u1' });
  expect(txService.reverseTransaction).toHaveBeenCalledTimes(1);
  expect(r.status).toBe('reversed');
});

it('a 500-employee single-cost-centre run still posts ONE entry', async () => {
  const emps = Array.from({ length: 500 }, (_, i) => ({ _id: `e${i}`, code: `E${i}`, fullName: `Emp${i}`, department: 'cc1', salaryStructure: [STRUCT] }));
  employeeRepo.findActive.mockResolvedValue(emps);
  let stored;
  runRepo.findActiveByPeriod.mockResolvedValue(null);
  runRepo.create.mockImplementation((doc) => { stored = { ...doc, _id: 'runP', postedJournalEntryIds: [], save: jest.fn().mockImplementation(function () { return Promise.resolve(this); }) }; return Promise.resolve(stored); });
  await payroll.processRun(BIZ, '2026-06', { adjustments: {} }, { id: 'u1' });
  runRepo.findOwned.mockResolvedValue(stored);
  await payroll.postToGL(BIZ, 'runP', { id: 'u1' });
  expect(ledgerPosting.postCompoundJournal).toHaveBeenCalledTimes(1);
});

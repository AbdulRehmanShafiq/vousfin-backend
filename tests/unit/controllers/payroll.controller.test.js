'use strict';
jest.mock('../../../services/payroll.service', () => ({
  processRun: jest.fn(), getRun: jest.fn(), listRuns: jest.fn(), postToGL: jest.fn(),
  markPaid: jest.fn(), reverseRun: jest.fn(),
}));
jest.mock('../../../repositories/employee.repository', () => ({ findByCode: jest.fn(), create: jest.fn(), findByBusiness: jest.fn(), findOwned: jest.fn(), update: jest.fn() }));

const payroll = require('../../../services/payroll.service');
const employeeRepo = require('../../../repositories/employee.repository');
const ctrl = require('../../../controllers/payroll.controller');

const res = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };
const REQ = (over = {}) => ({ user: { businessId: 'biz1', id: 'u1' }, body: {}, params: {}, ip: '127.0.0.1', ...over });

beforeEach(() => jest.clearAllMocks());

describe('createEmployee', () => {
  it('409s on a duplicate code (pre-check, since BaseRepository swallows 11000)', async () => {
    employeeRepo.findByCode.mockResolvedValue({ _id: 'e1' });
    const r = res(); const next = jest.fn();
    await ctrl.createEmployee(REQ({ body: { code: 'E001' } }), r, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
    expect(employeeRepo.create).not.toHaveBeenCalled();
  });

  it('creates when the code is free', async () => {
    employeeRepo.findByCode.mockResolvedValue(null);
    employeeRepo.create.mockResolvedValue({ _id: 'e1', code: 'E001' });
    const r = res(); const next = jest.fn();
    await ctrl.createEmployee(REQ({ body: { code: 'E001', fullName: 'Ali' } }), r, next);
    expect(employeeRepo.create).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'biz1', code: 'E001' }));
    expect(r.status).toHaveBeenCalledWith(201);
  });
});

describe('processRun', () => {
  it('delegates to the service with business + actor', async () => {
    payroll.processRun.mockResolvedValue({ _id: 'run1', status: 'processed' });
    const r = res(); const next = jest.fn();
    await ctrl.processRun(REQ({ body: { period: '2026-06', adjustments: {} } }), r, next);
    expect(payroll.processRun).toHaveBeenCalledWith('biz1', '2026-06',
      expect.objectContaining({ adjustments: {} }), expect.objectContaining({ id: 'u1' }));
    expect(r.status).toHaveBeenCalledWith(200);
  });
});

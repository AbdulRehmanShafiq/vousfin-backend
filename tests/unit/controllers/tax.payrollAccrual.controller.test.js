'use strict';

jest.mock('../../../repositories/payrollAccrual.repository', () => ({ upsertForMonth: jest.fn() }));

const payrollRepo = require('../../../repositories/payrollAccrual.repository');
const taxCtrl     = require('../../../controllers/tax.controller');

beforeEach(() => jest.clearAllMocks());

describe('tax.controller.addPayrollAccrual', () => {
  it('upserts the given month and returns the accrual', async () => {
    const saved = { businessId: 'biz1', month: '2026-06', eobi: 5000, sessi: 3000 };
    payrollRepo.upsertForMonth.mockResolvedValue(saved);

    const req  = { user: { businessId: 'biz1', _id: 'u1' }, body: { month: '2026-06', eobi: 5000, sessi: 3000 } };
    const json = jest.fn();
    await taxCtrl.addPayrollAccrual(req, { json }, jest.fn());

    expect(payrollRepo.upsertForMonth).toHaveBeenCalledWith('biz1', '2026-06', { eobi: 5000, sessi: 3000, createdBy: 'u1' });
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: saved }));
  });

  it('defaults the month to the current YYYY-MM when omitted', async () => {
    payrollRepo.upsertForMonth.mockResolvedValue({});
    const req = { user: { businessId: 'biz1' }, body: { eobi: 100 } };
    await taxCtrl.addPayrollAccrual(req, { json: jest.fn() }, jest.fn());

    const month = payrollRepo.upsertForMonth.mock.calls[0][1];
    expect(month).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
    expect(month).toBe(new Date().toISOString().slice(0, 7));
  });

  it('forwards errors to the error handler', async () => {
    const err = new Error('boom');
    payrollRepo.upsertForMonth.mockRejectedValue(err);
    const next = jest.fn();
    await taxCtrl.addPayrollAccrual({ user: { businessId: 'b' }, body: { eobi: 1 } }, { json: jest.fn() }, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});

'use strict';

jest.mock('../../../services/taxAdvisor.service', () => ({ getAdvisories: jest.fn() }));

const taxAdvisor = require('../../../services/taxAdvisor.service');
const taxCtrl    = require('../../../controllers/tax.controller');

beforeEach(() => jest.clearAllMocks());

describe('tax.controller.getAdvisories', () => {
  it('returns ranked advisories for the authenticated business', async () => {
    const payload = { currency: 'PKR', totalPotentialSavingPKR: 50000, advisories: [{ id: 'X' }] };
    taxAdvisor.getAdvisories.mockResolvedValue(payload);

    const json = jest.fn();
    await taxCtrl.getAdvisories({ user: { businessId: 'biz1' } }, { json }, jest.fn());

    expect(taxAdvisor.getAdvisories).toHaveBeenCalledWith('biz1');
    expect(json).toHaveBeenCalledWith({ success: true, data: payload });
  });

  it('forwards errors to the error handler', async () => {
    const err = new Error('boom');
    taxAdvisor.getAdvisories.mockRejectedValue(err);
    const next = jest.fn();
    await taxCtrl.getAdvisories({ user: { businessId: 'b' } }, { json: jest.fn() }, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});

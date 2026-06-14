'use strict';

jest.mock('../../../services/taxPosition.service', () => ({ getLivePosition: jest.fn() }));

const taxPosition = require('../../../services/taxPosition.service');
const taxCtrl     = require('../../../controllers/tax.controller');

beforeEach(() => jest.clearAllMocks());

describe('tax.controller.getPosition', () => {
  it('returns the live position for the authenticated business', async () => {
    const payload = { totalPayable: 1500, currency: 'PKR', taxes: [] };
    taxPosition.getLivePosition.mockResolvedValue(payload);

    const req  = { user: { businessId: 'biz1' } };
    const json = jest.fn();
    const next = jest.fn();
    await taxCtrl.getPosition(req, { json }, next);

    expect(taxPosition.getLivePosition).toHaveBeenCalledWith('biz1');
    expect(json).toHaveBeenCalledWith({ success: true, data: payload });
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors to the error handler', async () => {
    const err = new Error('boom');
    taxPosition.getLivePosition.mockRejectedValue(err);

    const next = jest.fn();
    await taxCtrl.getPosition({ user: { businessId: 'biz1' } }, { json: jest.fn() }, next);

    expect(next).toHaveBeenCalledWith(err);
  });
});

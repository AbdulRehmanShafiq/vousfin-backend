// tests/unit/controllers/team.controller.test.js — Phase 6A
'use strict';
jest.mock('../../../services/membership.service');
const membershipService = require('../../../services/membership.service');
const ctrl = require('../../../controllers/team.controller');

const mockRes = () => { const r = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r; };
beforeEach(() => jest.clearAllMocks());

test('invite forwards businessId, body and actor to the service', async () => {
  membershipService.invite.mockResolvedValue({ _id: 'm1' });
  const req = { user: { _id: 'u1', id: 'u1', businessId: 'b1' }, body: { email: 'a@b.com', roles: ['viewer'] } };
  const res = mockRes(); const next = jest.fn();
  await ctrl.invite(req, res, next);
  expect(membershipService.invite).toHaveBeenCalledWith('b1', { email: 'a@b.com', roles: ['viewer'] }, req.user);
  expect(res.status).toHaveBeenCalledWith(201);
});

test('updateRoles forwards target userId + roles', async () => {
  membershipService.updateRoles.mockResolvedValue({ _id: 'm1', roles: ['accountant'] });
  const req = { user: { _id: 'u1', id: 'u1', businessId: 'b1' }, params: { userId: 'u2' }, body: { roles: ['accountant'] } };
  const res = mockRes(); const next = jest.fn();
  await ctrl.updateRoles(req, res, next);
  expect(membershipService.updateRoles).toHaveBeenCalledWith('b1', 'u2', ['accountant'], req.user);
});

jest.mock('../../../services/membership.service');
const membershipService = require('../../../services/membership.service');
const { attachMembership, requirePermission } = require('../../../middleware/rbac.middleware');

const mkRes = () => ({});
beforeEach(() => jest.clearAllMocks());

test('attachMembership sets req.membership from the resolved roles', async () => {
  membershipService.resolveActiveMembership.mockResolvedValue({ roles: ['accountant'], status: 'active' });
  const req = { user: { id: 'u1', businessId: 'b1' } };
  const next = jest.fn();
  await attachMembership(req, mkRes(), next);
  expect(next).toHaveBeenCalledWith(); // no error
  expect(req.membership.roles).toEqual(['accountant']);
  expect(req.membership.permissions).toContain('transaction:create');
});

test('attachMembership 403s when the user has no membership', async () => {
  membershipService.resolveActiveMembership.mockResolvedValue(null);
  const req = { user: { id: 'u1', businessId: 'b1' } };
  const next = jest.fn();
  await attachMembership(req, mkRes(), next);
  expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  expect(next.mock.calls[0][0].statusCode).toBe(403);
});

test('requirePermission allows when permission present, 403s otherwise', () => {
  const ok = jest.fn();
  requirePermission('report:view')({ membership: { permissions: ['report:view'] } }, mkRes(), ok);
  expect(ok).toHaveBeenCalledWith();

  const denied = jest.fn();
  requirePermission('transaction:approve')({ membership: { permissions: ['report:view'] } }, mkRes(), denied);
  expect(denied.mock.calls[0][0].statusCode).toBe(403);
});

test('owner wildcard passes any permission', () => {
  const ok = jest.fn();
  requirePermission('anything:x')({ membership: { permissions: ['*'] } }, mkRes(), ok);
  expect(ok).toHaveBeenCalledWith();
});

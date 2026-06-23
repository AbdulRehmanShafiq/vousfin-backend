jest.mock('../../../services/membership.service');
const membershipService = require('../../../services/membership.service');
const { attachMembership, requirePermission, writeGuard, domainWriteGuard } = require('../../../middleware/rbac.middleware');

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

test('writeGuard lets GET through but requires the permission on writes', () => {
  const viewer = { membership: { permissions: ['report:view'] } };
  const g = writeGuard('transaction:create');
  const getNext = jest.fn(); g({ ...viewer, method: 'GET' }, mkRes(), getNext);
  expect(getNext).toHaveBeenCalledWith(); // GET passes
  const postNext = jest.fn(); g({ ...viewer, method: 'POST' }, mkRes(), postNext);
  expect(postNext.mock.calls[0][0].statusCode).toBe(403); // viewer blocked from writing
});

test('domainWriteGuard routes the permission by what the write does', () => {
  const g = domainWriteGuard({ create: 'transaction:create', approve: 'transaction:approve', reverse: 'transaction:reverse' });
  // accountant (create only) can create but not approve/reverse
  const acct = { membership: { permissions: ['transaction:create', 'report:view'] } };
  const createNext = jest.fn(); g({ ...acct, method: 'POST', path: '/' }, mkRes(), createNext);
  expect(createNext).toHaveBeenCalledWith();
  const approveNext = jest.fn(); g({ ...acct, method: 'POST', path: '/123/approve' }, mkRes(), approveNext);
  expect(approveNext.mock.calls[0][0].statusCode).toBe(403); // accountant can't approve
  const deleteNext = jest.fn(); g({ ...acct, method: 'DELETE', path: '/123' }, mkRes(), deleteNext);
  expect(deleteNext.mock.calls[0][0].statusCode).toBe(403); // accountant can't reverse/delete
  // approver can approve but not create
  const appr = { membership: { permissions: ['transaction:approve', 'report:view'] } };
  const apprOk = jest.fn(); g({ ...appr, method: 'POST', path: '/123/approve' }, mkRes(), apprOk);
  expect(apprOk).toHaveBeenCalledWith();
  const apprDenyCreate = jest.fn(); g({ ...appr, method: 'POST', path: '/' }, mkRes(), apprDenyCreate);
  expect(apprDenyCreate.mock.calls[0][0].statusCode).toBe(403); // approver can't create
});

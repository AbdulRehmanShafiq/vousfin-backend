// tests/unit/services/membership.service.test.js — Phase 6A
'use strict';

jest.mock('../../../repositories/membership.repository');
jest.mock('../../../repositories/user.repository');
jest.mock('../../../services/audit.service');
jest.mock('../../../utils/email.utils');

const repo = require('../../../repositories/membership.repository');
const userRepo = require('../../../repositories/user.repository');
const email = require('../../../utils/email.utils');
const service = require('../../../services/membership.service');
const { BUSINESS_ROLES, MEMBERSHIP_STATUS } = require('../../../config/constants');

beforeEach(() => jest.clearAllMocks());

test('invite creates an invited membership with a token and sends the email', async () => {
  repo.findByBusinessAndEmail.mockResolvedValue(null);
  userRepo.findByEmail.mockResolvedValue(null);
  repo.create.mockImplementation(async (d) => ({ _id: 'm1', ...d }));
  const m = await service.invite('biz1', { email: 'New@X.com', roles: ['accountant'] }, { _id: 'u1', businessId: 'biz1' });
  expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
    businessId: 'biz1', invitedEmail: 'new@x.com', roles: ['accountant'], status: MEMBERSHIP_STATUS.INVITED,
  }));
  expect(typeof repo.create.mock.calls[0][0].inviteToken).toBe('string');
  expect(email.sendTeamInviteEmail).toHaveBeenCalled();
});

test('invite rejects an invalid role', async () => {
  await expect(service.invite('biz1', { email: 'a@b.com', roles: ['superuser'] }, { _id: 'u1' }))
    .rejects.toThrow(/role/i);
});

test('invite rejects a duplicate member', async () => {
  repo.findByBusinessAndEmail.mockResolvedValue({ _id: 'm0' });
  await expect(service.invite('biz1', { email: 'a@b.com', roles: ['viewer'] }, { _id: 'u1' }))
    .rejects.toThrow(/already/i);
});

test('updateRoles blocks removing the last owner', async () => {
  repo.findByBusinessAndUser.mockResolvedValue({ _id: 'm1', businessId: 'biz1', userId: 'u2', roles: ['owner'], status: 'active' });
  repo.countActiveOwners.mockResolvedValue(1);
  await expect(service.updateRoles('biz1', 'u2', ['accountant'], { _id: 'u1' }))
    .rejects.toThrow(/owner/i);
});

test('acceptInvite activates a matching pending invite', async () => {
  repo.findByInviteToken.mockResolvedValue({
    _id: 'm1', businessId: 'biz1', invitedEmail: 'new@x.com', status: 'invited',
    inviteTokenExpiresAt: new Date(Date.now() + 1e6), save: jest.fn().mockResolvedValue(true),
  });
  const m = await service.acceptInvite('tok', { _id: 'u9', email: 'new@x.com' });
  expect(m.status).toBe(MEMBERSHIP_STATUS.ACTIVE);
  expect(m.userId).toBe('u9');
});

test('acceptInvite rejects when the email does not match', async () => {
  repo.findByInviteToken.mockResolvedValue({
    _id: 'm1', invitedEmail: 'new@x.com', status: 'invited',
    inviteTokenExpiresAt: new Date(Date.now() + 1e6), save: jest.fn(),
  });
  await expect(service.acceptInvite('tok', { _id: 'u9', email: 'other@x.com' })).rejects.toThrow(/match|invite/i);
});

test('removeMember blocks removing the last owner', async () => {
  repo.findByBusinessAndUser.mockResolvedValue({ _id: 'm1', businessId: 'biz1', userId: 'u2', roles: ['owner'], status: 'active' });
  repo.countActiveOwners.mockResolvedValue(1);
  await expect(service.removeMember('biz1', 'u2', { _id: 'u1' })).rejects.toThrow(/owner/i);
  expect(repo.delete).not.toHaveBeenCalled();
});

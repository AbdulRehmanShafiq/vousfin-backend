// tests/unit/services/admin.service.test.js
'use strict';

jest.mock('../../../repositories/user.repository');
jest.mock('../../../repositories/business.repository');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../services/audit.service');
jest.mock('../../../utils/email.utils');

const userRepository = require('../../../repositories/user.repository');
const businessRepository = require('../../../repositories/business.repository');
const transactionRepository = require('../../../repositories/transaction.repository');
const auditService = require('../../../services/audit.service');
const { sendAccountStatusEmail } = require('../../../utils/email.utils');

// Load fresh instance after mocks are set up
let adminService;
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();

  // Re-apply mocks after resetModules
  jest.mock('../../../repositories/user.repository');
  jest.mock('../../../repositories/business.repository');
  jest.mock('../../../repositories/account.repository');
  jest.mock('../../../repositories/transaction.repository');
  jest.mock('../../../services/audit.service');
  jest.mock('../../../utils/email.utils');

  adminService = require('../../../services/admin.service');
});

// ── Helpers ────────────────────────────────────────────────────────────────────

const makeUser = (overrides = {}) => ({
  _id: 'uid-1',
  fullName: 'Alice Smith',
  email: 'alice@example.com',
  role: 'customer',
  status: 'active',
  businessId: 'biz-1',
  ...overrides,
});

const makeAdmin = (overrides = {}) => ({
  _id: 'admin-1',
  fullName: 'Super Admin',
  email: 'admin@vousfin.com',
  role: 'admin',
  status: 'active',
  businessId: null,
  ...overrides,
});

// ── getSystemStats ─────────────────────────────────────────────────────────────

describe('adminService.getSystemStats()', () => {
  it('returns all expected fields including new ones', async () => {
    const userRepo = require('../../../repositories/user.repository');
    const bizRepo = require('../../../repositories/business.repository');
    const txRepo = require('../../../repositories/transaction.repository');

    userRepo.count
      .mockResolvedValueOnce(100)   // totalUsers
      .mockResolvedValueOnce(70)    // activeCustomers
      .mockResolvedValueOnce(5)     // suspendedCustomers
      .mockResolvedValueOnce(8)     // pendingCustomers
      .mockResolvedValueOnce(3)     // adminCount
      .mockResolvedValueOnce(20);   // newUsersLast30Days

    bizRepo.getTotalBusinessCount.mockResolvedValueOnce(65);
    txRepo.count.mockResolvedValueOnce(1500);

    const stats = await adminService.getSystemStats();

    expect(stats.totalUsers).toBe(100);
    expect(stats.activeCustomers).toBe(70);
    expect(stats.suspendedCustomers).toBe(5);
    expect(stats.totalBusinesses).toBe(65);
    expect(stats.pendingCustomers).toBe(8);
    expect(stats.adminCount).toBe(3);
    expect(stats.totalTransactions).toBe(1500);
    expect(stats.newUsersLast30Days).toBe(20);
  });
});

// ── getAllBusinesses ───────────────────────────────────────────────────────────

describe('adminService.getAllBusinesses()', () => {
  it('returns paginated shape with owner attached', async () => {
    const bizRepo = require('../../../repositories/business.repository');

    const rawBiz = {
      _id: 'biz-1',
      businessName: 'Acme Corp',
      businessType: 'Retail Store',
      currency: 'PKR',
      createdAt: new Date('2024-01-01'),
      userId: { _id: 'uid-1', fullName: 'Alice Smith', email: 'alice@example.com', status: 'active' },
    };

    bizRepo.findAllWithOwner.mockResolvedValueOnce({
      data: [rawBiz],
      total: 1,
      page: 1,
      limit: 25,
    });

    const result = await adminService.getAllBusinesses({ page: 1, limit: 25 });

    expect(result.total).toBe(1);
    expect(result.data).toHaveLength(1);
    // owner should be the populated userId
    expect(result.data[0].owner).toEqual(rawBiz.userId);
    // userId key should be renamed to owner
    expect(result.data[0].userId).toBeUndefined();
  });
});

// ── verifyCustomer ─────────────────────────────────────────────────────────────

describe('adminService.verifyCustomer()', () => {
  it('activates a pending customer and clears verificationToken', async () => {
    const userRepo = require('../../../repositories/user.repository');
    const audit = require('../../../services/audit.service');

    const pendingUser = makeUser({ status: 'pending', _id: 'uid-pending' });
    userRepo.findById.mockResolvedValueOnce(pendingUser);
    userRepo.update.mockResolvedValueOnce({ ...pendingUser, status: 'active', verificationToken: null });
    audit.logStatusChange = jest.fn().mockResolvedValue(undefined);

    const result = await adminService.verifyCustomer('uid-pending', 'admin-1', '127.0.0.1');

    expect(userRepo.update).toHaveBeenCalledWith('uid-pending', {
      status: 'active',
      verificationToken: null,
    });
    expect(result.status).toBe('active');
  });

  it('throws 400 if customer is already active', async () => {
    const userRepo = require('../../../repositories/user.repository');

    userRepo.findById.mockResolvedValueOnce(makeUser({ status: 'active', _id: 'uid-active' }));

    await expect(adminService.verifyCustomer('uid-active', 'admin-1', '127.0.0.1'))
      .rejects.toMatchObject({ statusCode: 400, message: 'Account is already active' });
  });

  it('throws 404 if user not found', async () => {
    const userRepo = require('../../../repositories/user.repository');
    userRepo.findById.mockResolvedValueOnce(null);

    await expect(adminService.verifyCustomer('uid-missing', 'admin-1', '127.0.0.1'))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws 404 if user is not a customer', async () => {
    const userRepo = require('../../../repositories/user.repository');
    userRepo.findById.mockResolvedValueOnce(makeAdmin({ _id: 'admin-2' }));

    await expect(adminService.verifyCustomer('admin-2', 'admin-1', '127.0.0.1'))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

// ── changeRole ─────────────────────────────────────────────────────────────────

describe('adminService.changeRole()', () => {
  it('throws 403 when admin tries to change their own role', async () => {
    await expect(adminService.changeRole('admin-1', 'admin-1', 'customer'))
      .rejects.toMatchObject({ statusCode: 403, message: 'You cannot change your own role.' });
  });

  it('throws 400 when trying to demote the last admin', async () => {
    const userRepo = require('../../../repositories/user.repository');

    const lastAdmin = makeAdmin({ _id: 'admin-2' });
    userRepo.findById.mockResolvedValueOnce(lastAdmin);
    userRepo.count.mockResolvedValueOnce(1); // only 1 admin left

    await expect(adminService.changeRole('admin-2', 'admin-1', 'customer'))
      .rejects.toMatchObject({ statusCode: 400, message: 'Cannot demote the last admin.' });
  });

  it('promotes a customer to admin', async () => {
    const userRepo = require('../../../repositories/user.repository');
    const audit = require('../../../services/audit.service');

    const customer = makeUser({ _id: 'uid-promote', role: 'customer' });
    userRepo.findById.mockResolvedValueOnce(customer);
    userRepo.update.mockResolvedValueOnce({ ...customer, role: 'admin' });
    audit.log = jest.fn().mockResolvedValue(undefined);

    const result = await adminService.changeRole('uid-promote', 'admin-1', 'admin');

    expect(userRepo.update).toHaveBeenCalledWith('uid-promote', { role: 'admin' });
    expect(result.role).toBe('admin');
  });

  it('demotes an admin to customer when there are multiple admins', async () => {
    const userRepo = require('../../../repositories/user.repository');
    const audit = require('../../../services/audit.service');

    const otherAdmin = makeAdmin({ _id: 'admin-2' });
    userRepo.findById.mockResolvedValueOnce(otherAdmin);
    userRepo.count.mockResolvedValueOnce(3); // 3 admins exist
    userRepo.update.mockResolvedValueOnce({ ...otherAdmin, role: 'customer' });
    audit.log = jest.fn().mockResolvedValue(undefined);

    const result = await adminService.changeRole('admin-2', 'admin-1', 'customer');

    expect(userRepo.update).toHaveBeenCalledWith('admin-2', { role: 'customer' });
    expect(result.role).toBe('customer');
  });

  it('throws 400 for an invalid role', async () => {
    const userRepo = require('../../../repositories/user.repository');
    userRepo.findById.mockResolvedValueOnce(makeUser({ _id: 'uid-1' }));

    await expect(adminService.changeRole('uid-1', 'admin-1', 'superuser'))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws 404 when user does not exist', async () => {
    const userRepo = require('../../../repositories/user.repository');
    userRepo.findById.mockResolvedValueOnce(null);

    await expect(adminService.changeRole('uid-ghost', 'admin-1', 'admin'))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

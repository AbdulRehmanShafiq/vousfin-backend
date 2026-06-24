'use strict';

// Mock dependencies before requiring service
jest.mock('../../../repositories/user.repository');
jest.mock('../../../repositories/business.repository');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../services/audit.service');
jest.mock('../../../utils/email.utils');
jest.mock('../../../models/AuditLog.model');
jest.mock('../../../services/userFeedback.service');
jest.mock('../../../services/support.service');
jest.mock('../../../services/announcement.service');

const userRepository = require('../../../repositories/user.repository');
const AuditLog = require('../../../models/AuditLog.model');
const auditService = require('../../../services/audit.service');
const adminService = require('../../../services/admin.service');

describe('AdminService — platform extensions', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('resetUserMfa', () => {
    it('clears mfa fields and logs action', async () => {
      const user = { _id: 'u1', businessId: 'b1', mfa: { enabled: true } };
      userRepository.findById = jest.fn().mockResolvedValue(user);
      userRepository.update = jest.fn().mockResolvedValue({ ...user, mfa: { enabled: false } });
      auditService.log = jest.fn().mockResolvedValue({});

      const result = await adminService.resetUserMfa('u1', 'admin1');

      expect(userRepository.update).toHaveBeenCalledWith('u1', {
        'mfa.enabled': false,
        'mfa.secret': null,
        'mfa.backupCodes': [],
      });
      expect(auditService.log).toHaveBeenCalled();
      expect(result.message).toMatch(/reset/i);
    });

    it('throws 404 when user not found', async () => {
      userRepository.findById = jest.fn().mockResolvedValue(null);
      await expect(adminService.resetUserMfa('bad', 'admin1')).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('getRecentActivity', () => {
    it('returns paginated shape', async () => {
      const mockFind = {
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([{ action: 'CREATED' }]),
      };
      AuditLog.find = jest.fn().mockReturnValue(mockFind);
      AuditLog.countDocuments = jest.fn().mockResolvedValue(1);

      const result = await adminService.getRecentActivity({ page: 1, limit: 10 });

      expect(result).toMatchObject({ data: expect.any(Array), total: 1, page: 1, limit: 10 });
    });
  });
});

// tests/unit/services/mfa.service.test.js
// Unit tests for NFR-SEC-01 TOTP MFA service.
// User model is mocked so no DB connection is required.

jest.mock('../../../models/User.model');
jest.mock('../../../utils/totp.util', () => ({
  generateSecret: jest.fn(() => 'MOCKSECRET'),
  keyuri: jest.fn((email, issuer, secret) => `otpauth://totp/${issuer}:${email}?secret=${secret}`),
  verifyToken: jest.fn(),
}));

const totp = require('../../../utils/totp.util');
const User = require('../../../models/User.model');
const mfaService = require('../../../services/mfa.service');

// Helper: build a mock Mongoose user document
const mockUser = (overrides = {}) => {
  const base = {
    _id: 'user123',
    email: 'test@example.com',
    mfa: { enabled: false, secret: null, backupCodes: [] },
    save: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
  return base;
};

describe('mfaService', () => {
  afterEach(() => jest.clearAllMocks());

  // ── generateSetup ────────────────────────────────────────────
  describe('generateSetup', () => {
    it('returns secret, backupCodes, and otpauthUrl when MFA not yet enabled', async () => {
      const user = mockUser();
      User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(user) });

      const result = await mfaService.generateSetup('user123');

      expect(result.secret).toBe('MOCKSECRET');
      expect(result.backupCodes).toHaveLength(8);
      expect(result.otpauthUrl).toContain('MOCKSECRET');
      expect(user.save).toHaveBeenCalled();
    });

    it('throws 400 when MFA already enabled', async () => {
      const user = mockUser({ mfa: { enabled: true, secret: 'S', backupCodes: [] } });
      User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(user) });

      await expect(mfaService.generateSetup('user123')).rejects.toMatchObject({ statusCode: 400 });
    });

    it('throws 404 when user not found', async () => {
      User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(null) });
      await expect(mfaService.generateSetup('bad')).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  // ── confirmEnrollment ────────────────────────────────────────
  describe('confirmEnrollment', () => {
    it('enables MFA when TOTP token is valid', async () => {
      const user = mockUser({ mfa: { enabled: false, secret: 'MOCKSECRET', backupCodes: [] } });
      User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(user) });
      totp.verifyToken.mockReturnValue(true);

      const result = await mfaService.confirmEnrollment('user123', '123456');

      expect(result.enabled).toBe(true);
      expect(user.mfa.enabled).toBe(true);
      expect(user.save).toHaveBeenCalled();
    });

    it('throws 400 when TOTP code is wrong', async () => {
      const user = mockUser({ mfa: { enabled: false, secret: 'MOCKSECRET', backupCodes: [] } });
      User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(user) });
      totp.verifyToken.mockReturnValue(false);

      await expect(mfaService.confirmEnrollment('user123', '000000')).rejects.toMatchObject({ statusCode: 400 });
    });

    it('throws 400 when setup not started (no secret)', async () => {
      const user = mockUser({ mfa: { enabled: false, secret: null, backupCodes: [] } });
      User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(user) });

      await expect(mfaService.confirmEnrollment('user123', '123456')).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  // ── verifyToken ──────────────────────────────────────────────
  describe('verifyToken', () => {
    it('returns true when TOTP code is correct', async () => {
      const user = mockUser({ mfa: { enabled: true, secret: 'MOCKSECRET', backupCodes: ['aa11bb22'] } });
      User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(user) });
      totp.verifyToken.mockReturnValue(true);

      expect(await mfaService.verifyToken('user123', '123456')).toBe(true);
    });

    it('returns false when TOTP code is wrong and no backup match', async () => {
      const user = mockUser({ mfa: { enabled: true, secret: 'MOCKSECRET', backupCodes: ['aa11bb22'] } });
      User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(user) });
      totp.verifyToken.mockReturnValue(false);

      expect(await mfaService.verifyToken('user123', '999999')).toBe(false);
    });

    it('consumes and accepts a valid backup code', async () => {
      const user = mockUser({ mfa: { enabled: true, secret: 'MOCKSECRET', backupCodes: ['aa11bb22', 'cc33dd44'] } });
      User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(user) });
      totp.verifyToken.mockReturnValue(false);

      const result = await mfaService.verifyToken('user123', 'aa11bb22');

      expect(result).toBe(true);
      expect(user.mfa.backupCodes).toEqual(['cc33dd44']); // first code removed
      expect(user.save).toHaveBeenCalled();
    });

    it('returns true (pass-through) when MFA is not enabled', async () => {
      const user = mockUser({ mfa: { enabled: false, secret: null, backupCodes: [] } });
      User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(user) });

      expect(await mfaService.verifyToken('user123', 'anything')).toBe(true);
    });
  });

  // ── disableMFA ───────────────────────────────────────────────
  describe('disableMFA', () => {
    it('clears MFA fields when token is valid', async () => {
      // verifyToken will be called internally → mock it
      const user = mockUser({ mfa: { enabled: true, secret: 'MOCKSECRET', backupCodes: [] } });
      // First call: verifyToken internally fetches the user
      User.findById
        .mockReturnValueOnce({ select: jest.fn().mockResolvedValue(user) }) // verifyToken
        .mockReturnValueOnce({ select: jest.fn().mockResolvedValue(user) }); // disableMFA fetch
      totp.verifyToken.mockReturnValue(true);

      const result = await mfaService.disableMFA('user123', '123456');

      expect(result.enabled).toBe(false);
      expect(user.mfa.enabled).toBe(false);
      expect(user.mfa.secret).toBeNull();
    });

    it('throws 401 when token is invalid', async () => {
      const user = mockUser({ mfa: { enabled: true, secret: 'MOCKSECRET', backupCodes: [] } });
      User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(user) });
      totp.verifyToken.mockReturnValue(false);

      await expect(mfaService.disableMFA('user123', 'wrong')).rejects.toMatchObject({ statusCode: 401 });
    });
  });
});

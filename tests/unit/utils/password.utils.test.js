// tests/unit/utils/password.utils.test.js
const { hashPassword, comparePassword } = require('../../../utils/password.utils');

describe('password.utils', () => {
  const plainPassword = 'SecureP@ss123';

  describe('hashPassword()', () => {
    test('should return a string hash', async () => {
      const hash = await hashPassword(plainPassword);
      expect(typeof hash).toBe('string');
    });

    test('should not return the plain password', async () => {
      const hash = await hashPassword(plainPassword);
      expect(hash).not.toBe(plainPassword);
    });

    test('should start with bcrypt prefix $2', async () => {
      const hash = await hashPassword(plainPassword);
      expect(hash.startsWith('$2')).toBe(true);
    });

    test('should produce different hashes for the same input (salted)', async () => {
      const hash1 = await hashPassword(plainPassword);
      const hash2 = await hashPassword(plainPassword);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('comparePassword()', () => {
    test('should return true for matching password and hash', async () => {
      const hash = await hashPassword(plainPassword);
      const result = await comparePassword(plainPassword, hash);
      expect(result).toBe(true);
    });

    test('should return false for wrong password', async () => {
      const hash = await hashPassword(plainPassword);
      const result = await comparePassword('WrongPassword!', hash);
      expect(result).toBe(false);
    });

    test('should return false for empty string vs valid hash', async () => {
      const hash = await hashPassword(plainPassword);
      const result = await comparePassword('', hash);
      expect(result).toBe(false);
    });
  });
});

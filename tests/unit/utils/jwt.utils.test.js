// tests/unit/utils/jwt.utils.test.js
const { generateToken, verifyToken } = require('../../../utils/jwt.utils');

describe('jwt.utils', () => {
  const userId = '507f1f77bcf86cd799439011';
  const role = 'customer';

  describe('generateToken()', () => {
    test('should return a non-empty string', () => {
      const token = generateToken(userId, role);
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });

    test('should return a valid JWT (3 parts separated by dots)', () => {
      const token = generateToken(userId, role);
      const parts = token.split('.');
      expect(parts).toHaveLength(3);
    });
  });

  describe('verifyToken()', () => {
    test('should decode a valid token and return correct payload', () => {
      const token = generateToken(userId, role);
      const decoded = verifyToken(token);
      expect(decoded.userId).toBe(userId);
      expect(decoded.role).toBe(role);
    });

    test('should throw "Invalid token" for a tampered token', () => {
      const token = generateToken(userId, role);
      const tampered = token.slice(0, -5) + 'XXXXX';
      expect(() => verifyToken(tampered)).toThrow('Invalid token');
    });

    test('should throw "Invalid token" for a random string', () => {
      expect(() => verifyToken('not.a.jwt')).toThrow('Invalid token');
    });

    test('should throw "Token expired" for an expired token', () => {
      // sign with -1s expiry
      const jwt = require('jsonwebtoken');
      const config = require('../../../config');
      const expiredToken = jwt.sign({ userId, role }, config.JWT_SECRET, { expiresIn: -1 });
      expect(() => verifyToken(expiredToken)).toThrow('Token expired');
    });

    test('round-trip: generate then verify matches original values', () => {
      const adminId = '507f1f77bcf86cd799439022';
      const token = generateToken(adminId, 'admin');
      const decoded = verifyToken(token);
      expect(decoded.userId).toBe(adminId);
      expect(decoded.role).toBe('admin');
    });
  });
});

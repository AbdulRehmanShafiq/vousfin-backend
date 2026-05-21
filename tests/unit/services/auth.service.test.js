// tests/unit/services/auth.service.test.js
// All external dependencies are mocked so no DB connection is needed.

jest.mock('../../../repositories/user.repository');
jest.mock('../../../repositories/business.repository');
jest.mock('../../../utils/email.utils');

const authService = require('../../../services/auth.service');
const userRepository = require('../../../repositories/user.repository');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../../../utils/email.utils');
const { ApiError } = require('../../../utils/ApiError');

// ── Helpers ────────────────────────────────────────────────────────────────────
const makeUser = (overrides = {}) => ({
  _id: '507f1f77bcf86cd799439011',
  fullName: 'Test User',
  email: 'test@vousfin.com',
  passwordHash: '$2b$12$hashedPasswordValue',
  authProvider: 'local',
  role: 'customer',
  status: 'active',
  tokenBlacklist: [],
  toObject: function () {
    const { toObject, ...rest } = this;
    return rest;
  },
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  sendVerificationEmail.mockResolvedValue(undefined);
  sendPasswordResetEmail.mockResolvedValue(undefined);
});

// ── registerUser ───────────────────────────────────────────────────────────────
describe('AuthService.registerUser()', () => {
  test('should throw 409 if email already exists', async () => {
    userRepository.findByEmail.mockResolvedValue(makeUser());
    await expect(
      authService.registerUser({ fullName: 'A', email: 'test@vousfin.com', password: 'P@ss1234' }, '127.0.0.1')
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test('should create user and return sanitized object (no passwordHash)', async () => {
    userRepository.findByEmail.mockResolvedValue(null);
    userRepository.create.mockResolvedValue(
      makeUser({ status: 'pending', verificationToken: 'tok123' })
    );

    const result = await authService.registerUser(
      { fullName: 'New User', email: 'new@vousfin.com', password: 'P@ss1234' },
      '127.0.0.1'
    );

    expect(userRepository.create).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty('passwordHash');
    expect(result).not.toHaveProperty('verificationToken');
  });

  test('should call sendVerificationEmail after creating user', async () => {
    userRepository.findByEmail.mockResolvedValue(null);
    userRepository.create.mockResolvedValue(makeUser({ status: 'pending', verificationToken: 'tok123' }));

    await authService.registerUser(
      { fullName: 'New User', email: 'new@vousfin.com', password: 'P@ss1234' },
      '127.0.0.1'
    );
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  test('should NOT throw if sendVerificationEmail fails (non-blocking)', async () => {
    userRepository.findByEmail.mockResolvedValue(null);
    userRepository.create.mockResolvedValue(makeUser({ status: 'pending', verificationToken: 'tok' }));
    sendVerificationEmail.mockRejectedValue(new Error('SMTP error'));

    await expect(
      authService.registerUser({ fullName: 'X', email: 'x@test.com', password: 'P@ss1234' }, '127.0.0.1')
    ).resolves.toBeDefined();
  });
});

// ── loginUser ──────────────────────────────────────────────────────────────────
describe('AuthService.loginUser()', () => {
  test('should throw 401 if user not found', async () => {
    userRepository.findByEmail.mockResolvedValue(null);
    await expect(authService.loginUser('no@one.com', 'pass', '127.0.0.1'))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  test('should throw 403 if account is suspended', async () => {
    userRepository.findByEmail.mockResolvedValue(makeUser({ status: 'suspended' }));
    await expect(authService.loginUser('test@vousfin.com', 'pass', '127.0.0.1'))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  test('should throw 403 if account is pending', async () => {
    userRepository.findByEmail.mockResolvedValue(makeUser({ status: 'pending' }));
    await expect(authService.loginUser('test@vousfin.com', 'pass', '127.0.0.1'))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  test('should throw 401 for wrong password', async () => {
    // Use a real bcrypt hash of 'CorrectPass' – comparePassword will be called with 'wrong'
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('CorrectPass', 4); // low rounds for speed in tests
    userRepository.findByEmail.mockResolvedValue(makeUser({ passwordHash: hash }));
    userRepository.update.mockResolvedValue({});

    await expect(authService.loginUser('test@vousfin.com', 'WrongPass', '127.0.0.1'))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  test('should return { user, token } on success', async () => {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('CorrectPass', 4);
    userRepository.findByEmail.mockResolvedValue(makeUser({ passwordHash: hash }));
    userRepository.update.mockResolvedValue({});

    const result = await authService.loginUser('test@vousfin.com', 'CorrectPass', '127.0.0.1');
    expect(result).toHaveProperty('token');
    expect(result).toHaveProperty('user');
    expect(result.user).not.toHaveProperty('passwordHash');
  });
});

// ── verifyEmail ───────────────────────────────────────────────────────────────
describe('AuthService.verifyEmail()', () => {
  test('should throw 400 for invalid token', async () => {
    userRepository.findByVerificationToken.mockResolvedValue(null);
    await expect(authService.verifyEmail('bad-token'))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('should throw 400 if already verified', async () => {
    userRepository.findByVerificationToken.mockResolvedValue(makeUser({ status: 'active' }));
    await expect(authService.verifyEmail('some-token'))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('should update user status to active on valid token', async () => {
    userRepository.findByVerificationToken.mockResolvedValue(makeUser({ status: 'pending' }));
    userRepository.update.mockResolvedValue(makeUser({ status: 'active', verificationToken: null }));

    const result = await authService.verifyEmail('valid-token');
    expect(userRepository.update).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      expect.objectContaining({ status: 'active', verificationToken: null })
    );
    expect(result).toBeDefined();
  });
});

// ── generateTokenForUser ───────────────────────────────────────────────────────
describe('AuthService.generateTokenForUser()', () => {
  test('should return a JWT string', () => {
    const user = { _id: '507f1f77bcf86cd799439011', role: 'customer' };
    const token = authService.generateTokenForUser(user);
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });

  test('should work with user.id instead of user._id', () => {
    const user = { id: '507f1f77bcf86cd799439011', role: 'admin' };
    const token = authService.generateTokenForUser(user);
    expect(typeof token).toBe('string');
  });
});

// tests/unit/controllers/auth.controller.test.js
// Tests each controller function in isolation – no real Express server needed.

jest.mock('../../../services/auth.service');
jest.mock('../../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const authController = require('../../../controllers/auth.controller');
const authService    = require('../../../services/auth.service');
const { ApiError }   = require('../../../utils/ApiError');

// ── Mock helpers ──────────────────────────────────────────────────────────────
const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  res.cookie = jest.fn().mockReturnValue(res);
  res.clearCookie = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  return res;
};

const mockReq = (body = {}, cookies = {}, user = null, ip = '127.0.0.1') => ({
  body,
  cookies,
  user,
  ip,
  headers: {},
});

const mockNext = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
});

// ── register ──────────────────────────────────────────────────────────────────
describe('authController.register()', () => {
  test('should call authService.registerUser and return 201', async () => {
    const fakeUser = { _id: 'u1', email: 'a@b.com', fullName: 'A' };
    authService.registerUser.mockResolvedValue(fakeUser);

    const req = mockReq({ fullName: 'A', email: 'a@b.com', password: 'P@ss123' });
    const res = mockRes();

    await authController.register(req, res, mockNext);

    expect(authService.registerUser).toHaveBeenCalledWith(
      { fullName: 'A', email: 'a@b.com', password: 'P@ss123' },
      '127.0.0.1'
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockNext).not.toHaveBeenCalled();
  });

  test('should call next(error) on service failure', async () => {
    authService.registerUser.mockRejectedValue(new ApiError(409, 'Email taken'));
    const req = mockReq({ fullName: 'A', email: 'dup@b.com', password: 'P@ss123' });
    const res = mockRes();

    await authController.register(req, res, mockNext);
    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
  });
});

// ── login ─────────────────────────────────────────────────────────────────────
describe('authController.login()', () => {
  test('should set cookie and return token on success', async () => {
    authService.loginUser.mockResolvedValue({
      user: { _id: 'u1', email: 'a@b.com' },
      token: 'jwt-token-string',
    });

    const req = mockReq({ email: 'a@b.com', password: 'P@ss123' });
    const res = mockRes();

    await authController.login(req, res, mockNext);

    expect(res.cookie).toHaveBeenCalledWith('token', 'jwt-token-string', expect.any(Object));
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true })
    );
    expect(mockNext).not.toHaveBeenCalled();
  });

  test('should call next(error) on wrong credentials', async () => {
    authService.loginUser.mockRejectedValue(new ApiError(401, 'Invalid credentials'));
    const req = mockReq({ email: 'a@b.com', password: 'wrong' });
    const res = mockRes();

    await authController.login(req, res, mockNext);
    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });
});

// ── verifyEmail ───────────────────────────────────────────────────────────────
describe('authController.verifyEmail()', () => {
  test('should return 200 on success', async () => {
    authService.verifyEmail.mockResolvedValue({ _id: 'u1', status: 'active' });
    const req = mockReq({ token: 'valid-tok' });
    const res = mockRes();

    await authController.verifyEmail(req, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('should call next(error) on bad token', async () => {
    authService.verifyEmail.mockRejectedValue(new ApiError(400, 'Invalid token'));
    const req = mockReq({ token: 'bad' });
    const res = mockRes();

    await authController.verifyEmail(req, res, mockNext);
    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });
});

// ── logout ────────────────────────────────────────────────────────────────────
describe('authController.logout()', () => {
  test('should throw 400 when no token present', async () => {
    const req = { body: {}, cookies: {}, headers: {}, ip: '127.0.0.1', user: { id: 'u1' } };
    const res = mockRes();

    await authController.logout(req, res, mockNext);
    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  test('should clear cookie and return success when token is in cookie', async () => {
    authService.logoutUser.mockResolvedValue(undefined);
    const req = {
      body: {},
      cookies: { token: 'jwt-token' },
      headers: {},
      ip: '127.0.0.1',
      user: { id: 'u1' },
    };
    const res = mockRes();

    await authController.logout(req, res, mockNext);
    expect(res.clearCookie).toHaveBeenCalledWith('token', expect.any(Object));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

// ── forgotPassword ────────────────────────────────────────────────────────────
describe('authController.forgotPassword()', () => {
  test('should always return 200 regardless of whether email exists', async () => {
    authService.requestPasswordReset.mockResolvedValue(undefined);
    const req = mockReq({ email: 'anyone@test.com' });
    const res = mockRes();

    await authController.forgotPassword(req, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockNext).not.toHaveBeenCalled();
  });
});

// ── resetPassword ─────────────────────────────────────────────────────────────
describe('authController.resetPassword()', () => {
  test('should return 200 on valid token and new password', async () => {
    authService.resetPassword.mockResolvedValue(undefined);
    const req = mockReq({ token: 'reset-tok', newPassword: 'NewP@ss1' });
    const res = mockRes();

    await authController.resetPassword(req, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('should call next(error) on invalid reset token', async () => {
    authService.resetPassword.mockRejectedValue(new ApiError(400, 'Invalid token'));
    const req = mockReq({ token: 'bad', newPassword: 'NewP@ss1' });
    const res = mockRes();

    await authController.resetPassword(req, res, mockNext);
    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });
});

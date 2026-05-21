// tests/integration/api/auth.integration.test.js
// Hits real Express routes but mocks auth service so no DB is needed.

jest.mock('../../../config/database', () => jest.fn().mockResolvedValue(undefined));
jest.mock('../../../config/passport', () => ({
  initialize: () => (req, res, next) => next(),
  authenticate: () => (req, res, next) => next(),
}));
jest.mock('../../../jobs/anomalyScan.job', () => ({ scheduleAnomalyScan: jest.fn() }));
jest.mock('../../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  stream: { write: jest.fn() },
}));

// Mock authService so no real user/DB logic runs
jest.mock('../../../services/auth.service');
// Mock user repo used by auth middleware
jest.mock('../../../repositories/user.repository');

const request    = require('supertest');
const app        = require('../../../app');
const authService = require('../../../services/auth.service');

const REGISTER_PAYLOAD = {
  fullName: 'Integration User',
  email: 'integ@vousfin.com',
  password: 'Secure@1234',
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ── POST /api/v1/auth/register ────────────────────────────────────────────────
describe('POST /api/v1/auth/register', () => {
  test('should return 201 when registration succeeds', async () => {
    authService.registerUser.mockResolvedValue({
      _id: 'u1', email: REGISTER_PAYLOAD.email, fullName: REGISTER_PAYLOAD.fullName,
    });

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send(REGISTER_PAYLOAD);

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('email', REGISTER_PAYLOAD.email);
  });

  test('should return 409 when email is already registered', async () => {
    const { ApiError } = require('../../../utils/ApiError');
    authService.registerUser.mockRejectedValue(new ApiError(409, 'Email already registered'));

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send(REGISTER_PAYLOAD);

    expect(res.statusCode).toBe(409);
    expect(res.body.success).toBe(false);
  });
});

// ── POST /api/v1/auth/login ───────────────────────────────────────────────────
describe('POST /api/v1/auth/login', () => {
  test('should return 200 and set cookie on valid credentials', async () => {
    authService.loginUser.mockResolvedValue({
      user: { _id: 'u1', email: REGISTER_PAYLOAD.email, role: 'customer' },
      token: 'valid.jwt.token',
    });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: REGISTER_PAYLOAD.email, password: REGISTER_PAYLOAD.password });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('token');
    // cookie should be set
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    expect(cookies.some(c => c.startsWith('token='))).toBe(true);
  });

  test('should return 401 on wrong credentials', async () => {
    const { ApiError } = require('../../../utils/ApiError');
    authService.loginUser.mockRejectedValue(new ApiError(401, 'Invalid email or password'));

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'bad@bad.com', password: 'wrong' });

    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test('should return 403 for unverified (pending) user', async () => {
    const { ApiError } = require('../../../utils/ApiError');
    authService.loginUser.mockRejectedValue(new ApiError(403, 'Please verify your email'));

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: REGISTER_PAYLOAD.email, password: REGISTER_PAYLOAD.password });

    expect(res.statusCode).toBe(403);
  });
});

// ── POST /api/v1/auth/verify-email ───────────────────────────────────────────
describe('POST /api/v1/auth/verify-email', () => {
  test('should return 200 on valid token', async () => {
    authService.verifyEmail.mockResolvedValue({ _id: 'u1', status: 'active' });

    const res = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ token: 'valid-verification-token' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('should return 400 on invalid token', async () => {
    const { ApiError } = require('../../../utils/ApiError');
    authService.verifyEmail.mockRejectedValue(new ApiError(400, 'Invalid or expired token'));

    const res = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ token: 'bad-token' });

    expect(res.statusCode).toBe(400);
  });
});

// ── POST /api/v1/auth/forgot-password ────────────────────────────────────────
describe('POST /api/v1/auth/forgot-password', () => {
  test('should return 200 regardless of whether email exists (security)', async () => {
    authService.requestPasswordReset.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'anyone@test.com' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ── POST /api/v1/auth/reset-password ─────────────────────────────────────────
describe('POST /api/v1/auth/reset-password', () => {
  test('should return 200 on valid reset token + new password', async () => {
    authService.resetPassword.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'valid-reset-tok', newPassword: 'NewP@ss1234', confirmPassword: 'NewP@ss1234' });

    expect(res.statusCode).toBe(200);
  });

  test('should return 400 on expired reset token', async () => {
    const { ApiError } = require('../../../utils/ApiError');
    authService.resetPassword.mockRejectedValue(new ApiError(400, 'Invalid or expired reset token'));

    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'expired', newPassword: 'NewP@ss1234', confirmPassword: 'NewP@ss1234' });

    expect(res.statusCode).toBe(400);
  });
});

// ── Protected route without token ─────────────────────────────────────────────
describe('Protected routes (no auth token)', () => {
  test('GET /api/v1/transactions → 401 without token', async () => {
    const res = await request(app).get('/api/v1/transactions');
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test('GET /api/v1/dashboard → 401 without token', async () => {
    const res = await request(app).get('/api/v1/dashboard');
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test('GET /api/v1/reports → 401 without token', async () => {
    const res = await request(app).get('/api/v1/reports');
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

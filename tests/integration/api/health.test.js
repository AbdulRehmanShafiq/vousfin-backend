// tests/integration/api/health.test.js
// Integration test – spins up the real Express app (no DB) via Supertest.
// The /health route and /api/v1/health route are tested WITHOUT any DB calls.

// We must mock mongoose connect so the app doesn't try to actually connect.
jest.mock('../../../config/database', () => jest.fn().mockResolvedValue(undefined));
jest.mock('../../../config/passport', () => ({
  initialize: () => (req, res, next) => next(),
  authenticate: () => (req, res, next) => next(),
}));
jest.mock('../../../jobs/anomalyScan.job', () => ({
  scheduleAnomalyScan: jest.fn(),
}));

// Silence Winston file transports in tests
jest.mock('../../../config/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  stream: { write: jest.fn() },
}));

const request = require('supertest');
const app = require('../../../app');

describe('Health Check Endpoints', () => {
  test('GET /health → 200 with success:true', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, message: 'Server is running' });
  });

  test('GET /api/v1/health → 200 with success:true', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, message: 'API is healthy' });
    expect(res.body).toHaveProperty('timestamp');
  });

  test('GET /nonexistent → 404 with success:false', async () => {
    const res = await request(app).get('/nonexistent-route-xyz');
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ success: false });
  });
});

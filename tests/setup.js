// tests/setup.js
// Must set env vars BEFORE any module that calls require('../config') loads.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI = 'mongodb://localhost:27017/vousfin_test';
process.env.JWT_SECRET = 'test-jwt-secret-for-testing-only';
process.env.CLIENT_URL = 'http://localhost:5173';
process.env.JWT_EXPIRY = '1h';
process.env.LOG_DIR = 'logs';
process.env.RATE_LIMIT_MAX_REQUESTS = '1000';

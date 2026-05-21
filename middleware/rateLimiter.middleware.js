// middleware/rateLimiter.middleware.js
const rateLimit = require('express-rate-limit');
const config = require('../config');

/**
 * Default rate limiter for general API routes.
 * Window: 15 minutes, Max: 100 requests per IP.
 */
const defaultLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000, // 15 minutes
  limit: config.RATE_LIMIT_MAX_REQUESTS || 100, // limit each IP to 100 requests per windowMs
  standardHeaders: 'draft-7', // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.',
  },
  skipSuccessfulRequests: false, // Count all requests (including successful ones)
});

/**
 * Stricter rate limiter for authentication routes (login, register).
 * Window: 15 minutes, Max: 5 attempts per IP.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 5, // only 5 login/register attempts per window
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many authentication attempts. Please try again after 15 minutes.',
  },
  skipSuccessfulRequests: true, // Don't count successful logins (optional)
});

/**
 * Rate limiter for AI endpoints (can be resource‑intensive).
 * Window: 1 minute, Max: 10 requests per IP.
 */
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 10, // 10 AI requests per minute
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many AI requests. Please slow down.',
  },
});

/**
 * Rate limiter for admin endpoints (tighter).
 * Window: 1 minute, Max: 30 requests per IP.
 */
const adminLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many admin requests. Please wait.',
  },
});

/**
 * Very strict limiter for password reset requests.
 * Window: 1 hour, Max: 3 requests per IP.
 */
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 3,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many password reset attempts. Please try again after an hour.',
  },
});

module.exports = {
  defaultLimiter,
  authLimiter,
  aiLimiter,
  adminLimiter,
  passwordResetLimiter,
};
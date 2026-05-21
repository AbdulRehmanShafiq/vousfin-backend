// middleware/logger.middleware.js
const morgan = require('morgan');
const logger = require('../config/logger');

/**
 * Create a Morgan stream that writes to Winston's info level.
 */
const stream = {
  write: (message) => {
    // Remove the trailing newline that Morgan adds
    logger.info(message.trim());
  },
};

/**
 * Custom Morgan format token to include response time in milliseconds.
 * Already included by Morgan's :response-time, but we add it to our format.
 */
morgan.token('custom-response-time', (req, res) => {
  const responseTime = res.getHeader('X-Response-Time');
  return responseTime ? `${responseTime}ms` : '-';
});

/**
 * Custom token to include user ID if authenticated.
 */
morgan.token('user-id', (req) => {
  return req.user ? req.user.id : 'unauthenticated';
});

/**
 * Custom token to include request body (only for errors or in development).
 * Be careful not to log sensitive data (passwords, tokens).
 */
morgan.token('body', (req) => {
  if (process.env.NODE_ENV === 'development' && req.body && Object.keys(req.body).length) {
    // Remove sensitive fields
    const safeBody = { ...req.body };
    if (safeBody.password) safeBody.password = '***REDACTED***';
    if (safeBody.passwordHash) safeBody.passwordHash = '***REDACTED***';
    if (safeBody.token) safeBody.token = '***REDACTED***';
    return JSON.stringify(safeBody);
  }
  return '-';
});

/**
 * Custom format string for Morgan.
 * Example: 2025-05-18 10:30:45 | POST /api/v1/auth/login | 200 | 45ms | 192.168.1.1 | user-id=123
 */
const morganFormat = ':date[iso] | :method :url | :status | :custom-response-time | :remote-addr | user-id=:user-id | :user-agent';

/**
 * Middleware that logs all HTTP requests using Morgan + Winston.
 * Uses the 'combined' format but we customise with our tokens.
 */
const loggerMiddleware = morgan(morganFormat, { stream, immediate: false });

/**
 * Optional: Middleware that sets X-Response-Time header.
 * Can be used with the custom token above.
 */
const setResponseTimeHeader = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    res.setHeader('X-Response-Time', duration);
  });
  next();
};

module.exports = {
  loggerMiddleware,
  setResponseTimeHeader,
};
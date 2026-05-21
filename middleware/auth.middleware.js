// middleware/auth.middleware.js
const { verifyToken } = require('../utils/jwt.utils');
const userRepository = require('../repositories/user.repository');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');

/**
 * Authentication middleware.
 * Verifies JWT, checks blacklist, ensures user is active.
 * Attaches user object to req.user.
 */
const authMiddleware = async (req, res, next) => {
  try {
    // Extract token from cookie or Authorization header
    let token = null;
    if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      throw new ApiError(401, 'Authentication required. No token provided.');
    }

    // Verify and decode token
    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (err) {
      logger.warn(`Token verification failed: ${err.message}`);
      if (err.message === 'Token expired') {
        throw new ApiError(401, 'Session expired. Please login again.');
      }
      throw new ApiError(401, 'Invalid token.');
    }

    // Check if token is blacklisted
    const isBlacklisted = await userRepository.isTokenBlacklisted(decoded.userId, token);
    if (isBlacklisted) {
      throw new ApiError(401, 'Token has been revoked. Please login again.');
    }

    // Fetch user from database (ensure it still exists and is active)
    const user = await userRepository.findActiveById(decoded.userId);
    if (!user) {
      throw new ApiError(401, 'User account not found or has been deleted.');
    }

    if (user.status !== 'active') {
      throw new ApiError(403, `Account is ${user.status}. Please contact support.`);
    }

    // Attach user to request object
    req.user = {
      id: user._id,
      email: user.email,
      role: user.role,
      fullName: user.fullName,
      businessId: user.businessId,
      status: user.status,
    };

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Optional middleware to attach user silently without throwing on failure.
 * Useful for public routes that can optionally show logged‑in state.
 * Instead of throwing, it just sets req.user = null and continues.
 */
const optionalAuthMiddleware = async (req, res, next) => {
  try {
    let token = null;
    if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (token) {
      const decoded = verifyToken(token);
      const isBlacklisted = await userRepository.isTokenBlacklisted(decoded.userId, token);
      if (!isBlacklisted) {
        const user = await userRepository.findActiveById(decoded.userId);
        if (user && user.status === 'active') {
          req.user = {
            id: user._id,
            email: user.email,
            role: user.role,
            fullName: user.fullName,
            businessId: user.businessId,
          };
        }
      }
    }
  } catch (err) {
    // Silently ignore – req.user remains undefined or null
  }
  next();
};

module.exports = {
  authMiddleware,
  optionalAuthMiddleware,
};
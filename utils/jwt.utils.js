// utils/jwt.utils.js
const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * Generate a JWT for a user.
 * @param {string} userId - User's MongoDB _id
 * @param {string} role - User's role (customer or admin)
 * @returns {string} - Signed JWT token
 */
const generateToken = (userId, role) => {
  const payload = { userId, role };
  const options = { expiresIn: config.JWT_EXPIRY };
  return jwt.sign(payload, config.JWT_SECRET, options);
};

/**
 * Verify a JWT and decode its payload.
 * @param {string} token - JWT token from client
 * @returns {Object} - Decoded payload { userId, role, iat, exp }
 * @throws {Error} - If token is invalid, expired, or signature mismatch
 */
const verifyToken = (token) => {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    return decoded;
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new Error('Token expired');
    } else if (error.name === 'JsonWebTokenError') {
      throw new Error('Invalid token');
    }
    throw error;
  }
};

/**
 * Add a token to the user's blacklist (for logout).
 * This function requires the User model or repository.
 * @param {string} userId - User ID
 * @param {string} token - JWT token to blacklist
 * @param {Object} userRepository - Instance of user repository (dependency injection)
 * @returns {Promise<void>}
 */
const blacklistToken = async (userId, token, userRepository) => {
  const user = await userRepository.findById(userId);
  if (user && !user.tokenBlacklist.includes(token)) {
    user.tokenBlacklist.push(token);
    await user.save();
  }
};

/**
 * Check if a token is blacklisted.
 * @param {string} userId - User ID
 * @param {string} token - JWT token to check
 * @param {Object} userRepository - Instance of user repository
 * @returns {Promise<boolean>}
 */
const isTokenBlacklisted = async (userId, token, userRepository) => {
  const user = await userRepository.findById(userId);
  return user ? user.tokenBlacklist.includes(token) : false;
};

module.exports = {
  generateToken,
  verifyToken,
  blacklistToken,
  isTokenBlacklisted,
};
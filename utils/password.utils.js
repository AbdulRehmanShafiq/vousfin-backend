// utils/password.utils.js
const bcrypt = require('bcryptjs');
const config = require('../config');

/**
 * Hash a plain-text password using bcrypt.
 * @param {string} plainPassword - The password to hash (plain text)
 * @returns {Promise<string>} - The bcrypt hash
 * @throws {Error} - If hashing fails
 */
const hashPassword = async (plainPassword) => {
  try {
    const saltRounds = config.BCRYPT_ROUNDS || 12;
    const hashedPassword = await bcrypt.hash(plainPassword, saltRounds);
    return hashedPassword;
  } catch (error) {
    throw new Error(`Password hashing failed: ${error.message}`);
  }
};

/**
 * Compare a plain-text password with a stored bcrypt hash.
 * @param {string} plainPassword - The password to check (plain text)
 * @param {string} hashedPassword - The stored bcrypt hash
 * @returns {Promise<boolean>} - True if passwords match, false otherwise
 * @throws {Error} - If comparison fails
 */
const comparePassword = async (plainPassword, hashedPassword) => {
  try {
    const isMatch = await bcrypt.compare(plainPassword, hashedPassword);
    return isMatch;
  } catch (error) {
    throw new Error(`Password comparison failed: ${error.message}`);
  }
};

module.exports = {
  hashPassword,
  comparePassword,
};
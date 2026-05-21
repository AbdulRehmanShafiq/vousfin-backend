// utils/sanitize.helper.js
const mongoose = require('mongoose');

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} input - Raw user input
 * @returns {string} - Escaped string
 */
const escapeHtml = (input) => {
  if (!input || typeof input !== 'string') return input;
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

/**
 * Remove dangerous characters and MongoDB operators from a string.
 * Specifically, this removes any dollar sign ($) to prevent NoSQL injection
 * of operators like $gt, $ne, $where.
 * @param {string} input - Raw user input
 * @returns {string} - Sanitized string
 */
const sanitizeString = (input) => {
  if (!input || typeof input !== 'string') return '';
  // Remove any $ prefix (MongoDB operator) and trim
  let cleaned = input.replace(/^\$+/, '').trim();
  // Also remove any remaining dollar signs (though less common)
  cleaned = cleaned.replace(/\$/g, '');
  return cleaned;
};

/**
 * Recursively sanitize an object or array by cleaning all string values.
 * Used for query parameters, request body, etc.
 * @param {any} obj - Object, array, or primitive
 * @returns {any} - Sanitized copy
 */
const sanitizeQueryObject = (obj) => {
  if (!obj) return obj;
  if (typeof obj === 'string') {
    return sanitizeString(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeQueryObject(item));
  }
  if (typeof obj === 'object') {
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      // Also sanitize the key? Keys usually not user-controlled, but safe to strip $ prefix
      const safeKey = key.replace(/^\$+/, '');
      sanitized[safeKey] = sanitizeQueryObject(value);
    }
    return sanitized;
  }
  return obj;
};

/**
 * Check if a string is a valid MongoDB ObjectId.
 * @param {string} id - Candidate ObjectId string
 * @returns {boolean}
 */
const isValidObjectId = (id) => {
  return mongoose.Types.ObjectId.isValid(id);
};

/**
 * Return a valid ObjectId or null.
 * @param {string} id - Candidate ObjectId string
 * @returns {mongoose.Types.ObjectId|null}
 */
const toValidObjectId = (id) => {
  if (isValidObjectId(id)) {
    return new mongoose.Types.ObjectId(id);
  }
  return null;
};

/**
 * Sanitize a single object ID from request parameters.
 * Throws a formatted error if invalid, making it easy to use in controllers.
 * @param {string} id - ID from req.params.id or similar
 * @returns {mongoose.Types.ObjectId}
 * @throws {Error} - If ID is invalid
 */
const sanitizeAndValidateId = (id) => {
  const validId = toValidObjectId(id);
  if (!validId) {
    const error = new Error('Invalid ID format');
    error.statusCode = 400;
    throw error;
  }
  return validId;
};

/**
 * Escape HTML in all string fields of an object (recursive).
 * Useful when returning user‑supplied data to the client to prevent XSS.
 * @param {any} obj - Object to escape
 * @returns {any} - New object with HTML‑escaped strings
 */
const escapeObjectHtml = (obj) => {
  if (!obj) return obj;
  if (typeof obj === 'string') {
    return escapeHtml(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(item => escapeObjectHtml(item));
  }
  if (typeof obj === 'object') {
    const escaped = {};
    for (const [key, value] of Object.entries(obj)) {
      escaped[key] = escapeObjectHtml(value);
    }
    return escaped;
  }
  return obj;
};

module.exports = {
  escapeHtml,
  sanitizeString,
  sanitizeQueryObject,
  isValidObjectId,
  toValidObjectId,
  sanitizeAndValidateId,
  escapeObjectHtml,
};
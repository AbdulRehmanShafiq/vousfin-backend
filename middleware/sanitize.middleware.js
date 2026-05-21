// middleware/sanitize.middleware.js
const { sanitizeQueryObject } = require('../utils/sanitize.helper');

/**
 * Sanitize request body, query, and params
 * This middleware should NOT delete req.body – only clean it
 */
const sanitizeRequest = () => {
  return (req, res, next) => {
    try {
      // Sanitize body (if it exists)
      if (req.body && typeof req.body === 'object') {
        req.body = sanitizeQueryObject(req.body);
      }
      
      // Sanitize query string (if it exists)
      if (req.query && typeof req.query === 'object') {
        req.query = sanitizeQueryObject(req.query);
      }
      
      // Sanitize route parameters (if they exist)
      if (req.params && typeof req.params === 'object') {
        req.params = sanitizeQueryObject(req.params);
      }
      
      next();
    } catch (error) {
      // If sanitization fails, log but don't crash – proceed with original body
      console.error('Sanitization error:', error.message);
      next();
    }
  };
};

module.exports = { sanitizeRequest };
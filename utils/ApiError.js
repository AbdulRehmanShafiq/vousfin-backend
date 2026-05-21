// utils/ApiError.js
/**
 * Custom error class for API errors.
 * Extends native Error to include HTTP status code and operational flag.
 */
class ApiError extends Error {
  /**
   * Create an API error.
   * @param {number} statusCode - HTTP status code (e.g., 400, 404, 500)
   * @param {string} message - Error message
   * @param {boolean} isOperational - Whether the error is operational (user‑facing) vs programming error
   */
  constructor(statusCode, message, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    
    // Capture stack trace (exclude constructor call from the trace)
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = ApiError;
module.exports.ApiError = ApiError;
// middleware/error.middleware.js
const mongoose = require('mongoose');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const logger = require('../config/logger');
const config = require('../config');

/**
 * Global error handling middleware.
 * Must be used after all routes and middleware.
 */
const errorMiddleware = (err, req, res, next) => {
  // Default values
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal server error';
  let stack = err.stack;

  // Handle Mongoose validation errors
  if (err instanceof mongoose.Error.ValidationError) {
    statusCode = 400;
    message = 'Validation failed';
    const errors = Object.values(err.errors).map(e => e.message);
    return ApiResponse.error(res, message, statusCode, { details: errors });
  }

  // Handle MongoDB duplicate key error (code 11000)
  if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyPattern)[0];
    message = `${field} already exists. Please use a different value.`;
    return ApiResponse.error(res, message, statusCode);
  }

  // Handle cast errors (invalid ObjectId)
  if (err instanceof mongoose.Error.CastError) {
    statusCode = 400;
    message = `Invalid ${err.path}: ${err.value}`;
    return ApiResponse.error(res, message, statusCode);
  }

  // If it's our custom ApiError, use its values
  if (err instanceof ApiError) {
    statusCode = err.statusCode;
    message = err.message;
    // For 4xx errors, we don't need to log stack traces (they are user errors)
    if (statusCode >= 500) {
      logger.error(`[${statusCode}] ${message}\n${stack}`);
    } else {
      logger.warn(`[${statusCode}] ${message}`);
    }
    return ApiResponse.error(res, message, statusCode);
  }

  // Unexpected / programming errors
  logger.error(`Unhandled error: ${message}\n${stack}`);

  // In production, hide error details from client
  if (config.NODE_ENV === 'production') {
    message = 'Something went wrong. Please try again later.';
  }

  return ApiResponse.error(res, message, statusCode);
};

module.exports = errorMiddleware;
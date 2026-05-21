// utils/logger.helper.js
const winston = require('winston');
const mainLogger = require('../config/logger');

/**
 * Create a child logger with a module-specific prefix.
 * @param {string} moduleName - Name of the module (e.g., 'AuthService', 'TransactionRepository')
 * @returns {winston.Logger} Logger instance with module prefix
 */
const getLogger = (moduleName) => {
  // If we want to use the existing logger but add a prefix, we can create a new logger
  // with a custom format that includes the module name. Alternatively, we can use
  // winston's child() method if we want to add default metadata.
  return winston.createLogger({
    // Reuse the same transports as the main logger
    transports: mainLogger.transports,
    // Override the format to include module name
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
        let log = `${timestamp} [${level.toUpperCase()}] [${moduleName}]: ${message}`;
        if (Object.keys(meta).length > 0) {
          log += ` ${JSON.stringify(meta)}`;
        }
        if (stack) {
          log += `\n${stack}`;
        }
        return log;
      })
    ),
    // Inherit exception and rejection handlers
    exceptionHandlers: mainLogger.exceptionHandlers,
    rejectionHandlers: mainLogger.rejectionHandlers,
    exitOnError: false,
  });
};

// Export the main logger for convenience (without module prefix)
module.exports = {
  logger: mainLogger,      // raw main logger
  getLogger,               // factory for contextual logger
};
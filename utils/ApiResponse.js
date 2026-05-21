// utils/ApiResponse.js
/**
 * Standardized API response utility.
 * Every controller should use these methods to send consistent responses.
 */
class ApiResponse {
  /**
   * Send a success response.
   * @param {Object} res - Express response object
   * @param {*} data - Payload to send (optional)
   * @param {string} message - Success message (optional, default: 'Success')
   * @param {number} statusCode - HTTP status code (default: 200)
   * @returns {Object} Express response
   */
  static success(res, data = null, message = 'Success', statusCode = 200) {
    return res.status(statusCode).json({
      success: true,
      message,
      data,
    });
  }

  /**
   * Send an error response.
   * @param {Object} res - Express response object
   * @param {string} message - Error message (optional, default: 'Internal server error')
   * @param {number} statusCode - HTTP status code (default: 500)
   * @returns {Object} Express response
   */
  static error(res, message = 'Internal server error', statusCode = 500) {
    return res.status(statusCode).json({
      success: false,
      message,
      data: null,
    });
  }

  /**
   * Send a "created" response (201) with data.
   * Shortcut for success with status 201.
   * @param {Object} res - Express response object
   * @param {*} data - Created resource data
   * @param {string} message - Success message (default: 'Resource created successfully')
   * @returns {Object} Express response
   */
  static created(res, data, message = 'Resource created successfully') {
    return this.success(res, data, message, 201);
  }

  /**
   * Send a "no content" response (204).
   * Useful for DELETE operations that return no data.
   * @param {Object} res - Express response object
   * @returns {Object} Express response
   */
  static noContent(res) {
    return res.status(204).send();
  }
}

module.exports = ApiResponse;
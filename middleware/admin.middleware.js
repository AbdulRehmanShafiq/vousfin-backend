// middleware/admin.middleware.js
const { ApiError } = require('../utils/ApiError');

/**
 * Admin authorization middleware.
 * Must be used after authMiddleware (so req.user is populated).
 * Throws 403 if the authenticated user is not an admin.
 */
const adminMiddleware = (req, res, next) => {
  // First ensure user is authenticated (authMiddleware should have run)
  if (!req.user) {
    return next(new ApiError(401, 'Authentication required before admin access'));
  }

  // Check role
  if (req.user.role !== 'admin') {
    return next(new ApiError(403, 'Forbidden. Admin access required.'));
  }

  // User is admin, proceed
  next();
};

module.exports = adminMiddleware;
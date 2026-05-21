// middleware/business.middleware.js
const { ApiError } = require('../utils/ApiError');
const { isValidObjectId } = require('../utils/sanitize.helper');
const businessRepository = require('../repositories/business.repository');

/**
 * Middleware to ensure the authenticated user has a business profile.
 * Must be used after authMiddleware.
 * If businessId is missing or invalid, returns 403.
 */
const requireBusiness = async (req, res, next) => {
  try {
    // Ensure user is authenticated (should be, but double-check)
    if (!req.user) {
      throw new ApiError(401, 'Authentication required before business access');
    }

    // Check if user has a businessId
    if (!req.user.businessId) {
      throw new ApiError(403, 'Business profile not found. Please complete business setup first.');
    }

    // Optional: validate that the businessId is a valid ObjectId format
    if (!isValidObjectId(req.user.businessId)) {
      throw new ApiError(403, 'Invalid business ID format. Please contact support.');
    }

    // Optional: verify that the business actually exists in the database (for extra safety)
    const business = await businessRepository.findById(req.user.businessId);
    if (!business) {
      throw new ApiError(403, 'Business profile no longer exists. Please contact support.');
    }

    // Attach business object to request for convenience (optional)
    req.business = {
      id: business._id,
      name: business.businessName,
      type: business.businessType,
      currency: business.currency,
      fiscalYearStartMonth: business.fiscalYearStartMonth,
    };

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Lightweight version that only checks existence of businessId without DB lookup.
 * For performance-critical endpoints where the business object isn't needed.
 */
const requireBusinessSimple = (req, res, next) => {
  if (!req.user) {
    return next(new ApiError(401, 'Authentication required'));
  }
  if (!req.user.businessId) {
    return next(new ApiError(403, 'Business profile required. Please complete setup.'));
  }
  next();
};

module.exports = {
  requireBusiness,
  requireBusinessSimple,
};
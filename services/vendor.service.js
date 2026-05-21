const vendorRepository = require('../repositories/vendor.repository');
const transactionRepository = require('../repositories/transaction.repository');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');

class VendorService {
  /**
   * Create a new vendor
   * @param {string} businessId - The business ID
   * @param {Object} vendorData - Vendor details
   * @returns {Promise<Object>} - Created vendor object
   */
  async createVendor(businessId, vendorData) {
    if (!businessId) {
      throw new ApiError(400, 'Business ID is required');
    }
    const vendor = await vendorRepository.create({
      businessId,
      ...vendorData
    });
    logger.info(`Vendor created for business ${businessId}: ${vendor._id}`);
    return vendor;
  }

  /**
   * Update an existing vendor
   * @param {string} vendorId - The vendor ID
   * @param {string} businessId - The business ID
   * @param {Object} updateData - Fields to update
   * @returns {Promise<Object>} - Updated vendor object
   */
  async updateVendor(vendorId, businessId, updateData) {
    const vendor = await vendorRepository.findByBusinessAndId(businessId, vendorId);
    if (!vendor) {
      throw new ApiError(404, 'Vendor not found');
    }
    const updated = await vendorRepository.update(vendorId, updateData);
    logger.info(`Vendor updated: ${vendorId}`);
    return updated;
  }

  /**
   * Get a vendor by ID
   * @param {string} vendorId - The vendor ID
   * @param {string} businessId - The business ID
   * @returns {Promise<Object>} - Vendor object
   */
  async getVendorById(vendorId, businessId) {
    const vendor = await vendorRepository.findByBusinessAndId(businessId, vendorId);
    if (!vendor) {
      throw new ApiError(404, 'Vendor not found');
    }
    return vendor;
  }

  /**
   * List vendors for a business
   * @param {string} businessId - The business ID
   * @param {Object} filters - Optional filters
   * @param {Object} pagination - Pagination parameters
   * @returns {Promise<Object>} - Paginated list of vendors
   */
  async listVendors(businessId, filters = {}, pagination = {}) {
    if (!businessId) {
      throw new ApiError(400, 'Business ID is required');
    }
    return vendorRepository.findByBusiness(businessId, filters, pagination);
  }

  /**
   * Get payable balance for a vendor
   * @param {string} vendorId - The vendor ID
   * @param {string} businessId - The business ID
   * @returns {Promise<number>} - Vendor payable balance
   */
  async getVendorPayableBalance(vendorId, businessId) {
    const vendor = await vendorRepository.findByBusinessAndId(businessId, vendorId);
    if (!vendor) {
      throw new ApiError(404, 'Vendor not found');
    }
    return vendor.currentPayableBalance || 0;
  }

  /**
   * Get transaction history for a vendor
   * @param {string} vendorId - The vendor ID
   * @param {string} businessId - The business ID
   * @param {Object} filters - Optional transaction filters
   * @param {Object} pagination - Pagination and sorting options
   * @returns {Promise<Object>} - Paginated transaction history
   */
  async getVendorTransactionHistory(vendorId, businessId, filters = {}, pagination = {}) {
    const vendor = await vendorRepository.findByBusinessAndId(businessId, vendorId);
    if (!vendor) {
      throw new ApiError(404, 'Vendor not found');
    }
    return transactionRepository.findByVendor(businessId, vendorId, filters, pagination);
  }

  /**
   * Toggle the active status of a vendor
   * @param {string} vendorId - The vendor ID
   * @param {string} businessId - The business ID
   * @returns {Promise<Object>} - Updated vendor object
   */
  async toggleVendorActive(vendorId, businessId) {
    const vendor = await vendorRepository.findByBusinessAndId(businessId, vendorId);
    if (!vendor) {
      throw new ApiError(404, 'Vendor not found');
    }
    const newStatus = vendor.isActive === undefined ? false : !vendor.isActive;
    const updated = await vendorRepository.update(vendorId, { isActive: newStatus });
    logger.info(`Vendor ${vendorId} active status changed to ${newStatus}`);
    return updated;
  }
}

module.exports = new VendorService();

const customerRepository = require('../repositories/customer.repository');
const transactionRepository = require('../repositories/transaction.repository');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');

class CustomerService {
  /**
   * Create a new customer
   * @param {string} businessId - The business ID
   * @param {Object} customerData - Customer details
   * @returns {Promise<Object>} - Created customer object
   */
  async createCustomer(businessId, customerData) {
    if (!businessId) {
      throw new ApiError(400, 'Business ID is required');
    }
    const customer = await customerRepository.create({
      businessId,
      ...customerData
    });
    logger.info(`Customer created for business ${businessId}: ${customer._id}`);
    return customer;
  }

  /**
   * Update an existing customer
   * @param {string} customerId - The customer ID
   * @param {string} businessId - The business ID
   * @param {Object} updateData - Fields to update
   * @returns {Promise<Object>} - Updated customer object
   */
  async updateCustomer(customerId, businessId, updateData) {
    const customer = await customerRepository.findByBusinessAndId(businessId, customerId);
    if (!customer) {
      throw new ApiError(404, 'Customer not found');
    }
    const updated = await customerRepository.update(customerId, updateData);
    logger.info(`Customer updated: ${customerId}`);
    return updated;
  }

  /**
   * Get a customer by ID
   * @param {string} customerId - The customer ID
   * @param {string} businessId - The business ID
   * @returns {Promise<Object>} - Customer object
   */
  async getCustomerById(customerId, businessId) {
    const customer = await customerRepository.findByBusinessAndId(businessId, customerId);
    if (!customer) {
      throw new ApiError(404, 'Customer not found');
    }
    return customer;
  }

  /**
   * List customers for a business
   * @param {string} businessId - The business ID
   * @param {Object} filters - Optional filters
   * @param {Object} pagination - Pagination parameters
   * @returns {Promise<Object>} - Paginated list of customers
   */
  async listCustomers(businessId, filters = {}, pagination = {}) {
    if (!businessId) {
      throw new ApiError(400, 'Business ID is required');
    }
    return customerRepository.findByBusiness(businessId, filters, pagination);
  }

  /**
   * Get total balance for a customer
   * @param {string} customerId - The customer ID
   * @param {string} businessId - The business ID
   * @returns {Promise<number>} - Customer balance
   */
  async getCustomerBalance(customerId, businessId) {
    const customer = await customerRepository.findByBusinessAndId(businessId, customerId);
    if (!customer) {
      throw new ApiError(404, 'Customer not found');
    }
    return customer.currentReceivableBalance || 0;
  }

  /**
   * Get transaction history for a customer
   * @param {string} customerId - The customer ID
   * @param {string} businessId - The business ID
   * @param {Object} filters - Optional transaction filters
   * @param {Object} pagination - Pagination and sorting options
   * @returns {Promise<Object>} - Paginated transaction history
   */
  async getCustomerTransactionHistory(customerId, businessId, filters = {}, pagination = {}) {
    const customer = await customerRepository.findByBusinessAndId(businessId, customerId);
    if (!customer) {
      throw new ApiError(404, 'Customer not found');
    }
    return transactionRepository.findByCustomer(businessId, customerId, filters, pagination);
  }

  /**
   * Toggle the active status of a customer
   * @param {string} customerId - The customer ID
   * @param {string} businessId - The business ID
   * @returns {Promise<Object>} - Updated customer object
   */
  async toggleCustomerActive(customerId, businessId) {
    const customer = await customerRepository.findByBusinessAndId(businessId, customerId);
    if (!customer) {
      throw new ApiError(404, 'Customer not found');
    }
    const newStatus = customer.isActive === undefined ? false : !customer.isActive;
    const updated = await customerRepository.update(customerId, { isActive: newStatus });
    logger.info(`Customer ${customerId} active status changed to ${newStatus}`);
    return updated;
  }
}

module.exports = new CustomerService();

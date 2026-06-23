const customerRepository = require('../repositories/customer.repository');
const transactionRepository = require('../repositories/transaction.repository');
const amlScreening = require('./amlScreening.service');
const JournalEntry = require('../models/JournalEntry.model');
const { ApiError } = require('../utils/ApiError');
const { TRANSACTION_TYPES, PAYMENT_STATUS } = require('../config/constants');
const logger = require('../config/logger');
const mongoose = require('mongoose');

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
    // AML screening — fire-and-forget, must not block customer creation
    amlScreening.screenCounterparty(businessId, {
      counterpartyType: 'customer',
      counterpartyId: customer._id,
      counterpartyName: customer.name || customer.businessName || '',
    }).catch(console.error);
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
   * Aggregate ERP-style customer activity statistics.
   *
   * Returns:
   *   - currentReceivable       : Outstanding AR (denormalized field)
   *   - lifetimeRevenue         : Sum of all Credit Sale + Income amounts
   *   - lifetimePaymentsReceived: Sum of Payment Received amounts
   *   - invoiceCount            : Count of Credit Sale entries
   *   - paymentCount            : Count of Payment Received entries
   *   - avgInvoiceValue         : Average Credit Sale amount
   *   - overdueCount            : Number of overdue invoices (paymentStatus = OVERDUE)
   *   - lastInvoiceDate         : Most recent Credit Sale date
   *   - lastPaymentDate         : Most recent Payment Received date
   *   - lastActivityDate        : Most recent activity of ANY type
   *
   * @param {string} customerId
   * @param {string} businessId
   * @returns {Promise<Object>}
   */
  async getCustomerStats(customerId, businessId) {
    const customer = await customerRepository.findByBusinessAndId(businessId, customerId);
    if (!customer) throw new ApiError(404, 'Customer not found');

    const customerObjId = new mongoose.Types.ObjectId(String(customerId));
    const businessObjId = new mongoose.Types.ObjectId(String(businessId));

    const [stats] = await JournalEntry.aggregate([
      {
        $match: {
          businessId: businessObjId,
          customerId: customerObjId,
          isArchived: { $ne: true },
        },
      },
      {
        $group: {
          _id: null,
          // Revenue types: Credit Sale (primary) + legacy/mis-labeled types that
          // are still revenue (Inventory Sale, Income, Cash Sale).
          // Under GAAP, any debit to AR with a revenue credit is a sale regardless
          // of the type label — so we count all sale-like types here for resilience.
          lifetimeRevenue: {
            $sum: {
              $cond: [
                {
                  $in: ['$transactionType', [
                    TRANSACTION_TYPES.CREDIT_SALE,
                    TRANSACTION_TYPES.INVENTORY_SALE,
                    TRANSACTION_TYPES.CASH_SALE,
                    TRANSACTION_TYPES.INCOME,
                  ]],
                },
                '$amount',
                0,
              ],
            },
          },
          lifetimePaymentsReceived: {
            $sum: {
              $cond: [
                { $eq: ['$transactionType', TRANSACTION_TYPES.PAYMENT_RECEIVED] },
                '$amount',
                0,
              ],
            },
          },
          // Invoice count: Credit Sale + Inventory Sale (both create AR obligations)
          invoiceCount: {
            $sum: {
              $cond: [{
                $in: ['$transactionType', [
                  TRANSACTION_TYPES.CREDIT_SALE,
                  TRANSACTION_TYPES.INVENTORY_SALE,
                ]],
              }, 1, 0],
            },
          },
          paymentCount: {
            $sum: {
              $cond: [{ $eq: ['$transactionType', TRANSACTION_TYPES.PAYMENT_RECEIVED] }, 1, 0],
            },
          },
          overdueCount: {
            $sum: {
              $cond: [{ $eq: ['$paymentStatus', PAYMENT_STATUS.OVERDUE] }, 1, 0],
            },
          },
          // Invoice amount sum: same broad types as invoiceCount
          invoiceAmountSum: {
            $sum: {
              $cond: [{
                $in: ['$transactionType', [
                  TRANSACTION_TYPES.CREDIT_SALE,
                  TRANSACTION_TYPES.INVENTORY_SALE,
                ]],
              }, '$amount', 0],
            },
          },
          lastInvoiceDate: {
            $max: {
              $cond: [
                {
                  $in: ['$transactionType', [
                    TRANSACTION_TYPES.CREDIT_SALE,
                    TRANSACTION_TYPES.INVENTORY_SALE,
                  ]],
                },
                '$transactionDate',
                null,
              ],
            },
          },
          lastPaymentDate: {
            $max: {
              $cond: [
                { $eq: ['$transactionType', TRANSACTION_TYPES.PAYMENT_RECEIVED] },
                '$transactionDate',
                null,
              ],
            },
          },
          lastActivityDate: { $max: '$transactionDate' },
        },
      },
    ]);

    const safe = stats || {
      lifetimeRevenue: 0,
      lifetimePaymentsReceived: 0,
      invoiceCount: 0,
      paymentCount: 0,
      overdueCount: 0,
      invoiceAmountSum: 0,
      lastInvoiceDate: null,
      lastPaymentDate: null,
      lastActivityDate: null,
    };

    return {
      currentReceivable: customer.currentReceivableBalance || 0,
      lifetimeRevenue: safe.lifetimeRevenue,
      lifetimePaymentsReceived: safe.lifetimePaymentsReceived,
      invoiceCount: safe.invoiceCount,
      paymentCount: safe.paymentCount,
      overdueCount: safe.overdueCount,
      avgInvoiceValue: safe.invoiceCount > 0
        ? Math.round((safe.invoiceAmountSum / safe.invoiceCount) * 100) / 100
        : 0,
      lastInvoiceDate: safe.lastInvoiceDate,
      lastPaymentDate: safe.lastPaymentDate,
      lastActivityDate: safe.lastActivityDate,
    };
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

  /**
   * Generate a customer statement — full chronological ledger with running balance.
   *
   * Returns:
   *   - customer: profile info
   *   - openingBalance: 0 (or from start of period)
   *   - lines: [ { date, description, invoiceNumber, type, debit, credit, balance, paymentStatus } ]
   *   - closingBalance: outstanding AR at end of period
   *   - summary: { totalInvoiced, totalPaid, outstanding, overdueAmount }
   *
   * @param {string} customerId
   * @param {string} businessId
   * @param {Object} opts - { startDate?, endDate? }
   * @returns {Promise<Object>}
   */
  async getCustomerStatement(customerId, businessId, opts = {}) {
    const customer = await customerRepository.findByBusinessAndId(businessId, customerId);
    if (!customer) throw new ApiError(404, 'Customer not found');

    const { startDate, endDate } = opts;
    const filter = { limit: 500, sortBy: 'transactionDate', sortOrder: 'asc' };
    if (startDate) filter.startDate = startDate;
    if (endDate)   filter.endDate   = endDate;

    const txResult = await transactionRepository.findByCustomer(businessId, customerId, filter, { limit: 500, sortBy: 'transactionDate', sortOrder: 1 });
    const entries  = Array.isArray(txResult?.data) ? txResult.data
                   : Array.isArray(txResult)       ? txResult : [];

    let runningBalance = 0;
    const now = Date.now();

    const lines = entries.map((tx) => {
      const isSale    = [TRANSACTION_TYPES.CREDIT_SALE, TRANSACTION_TYPES.INVENTORY_SALE, TRANSACTION_TYPES.CASH_SALE, TRANSACTION_TYPES.INCOME].includes(tx.transactionType);
      const isPayment = tx.transactionType === TRANSACTION_TYPES.PAYMENT_RECEIVED;
      const debit  = isSale    ? tx.amount : 0;
      const credit = isPayment ? tx.amount : 0;
      runningBalance += debit - credit;

      // Compute days overdue for this line
      const dueRef = tx.dueDate || tx.transactionDate;
      const daysOverdue = dueRef ? Math.max(0, Math.floor((now - new Date(dueRef).getTime()) / 86400000)) : 0;

      return {
        _id:           tx._id,
        date:          tx.transactionDate,
        description:   tx.description,
        invoiceNumber: tx.invoiceNumber || tx.transactionReference || null,
        type:          tx.transactionType,
        debit:         Math.round(debit * 100) / 100,
        credit:        Math.round(credit * 100) / 100,
        balance:       Math.round(runningBalance * 100) / 100,
        paymentStatus: tx.paymentStatus || null,
        dueDate:       tx.dueDate || null,
        daysOverdue:   isSale ? daysOverdue : 0,
        remainingBalance: tx.remainingBalance || 0,
      };
    });

    const totalInvoiced = lines.reduce((s, l) => s + l.debit,  0);
    const totalPaid     = lines.reduce((s, l) => s + l.credit, 0);
    const overdueAmount = lines
      .filter((l) => l.daysOverdue > 0 && l.remainingBalance > 0)
      .reduce((s, l) => s + l.remainingBalance, 0);

    return {
      customer: {
        _id:          customer._id,
        fullName:     customer.fullName,
        businessName: customer.businessName,
        email:        customer.email,
        phone:        customer.phone,
        address:      customer.address,
        taxId:        customer.taxId,
        paymentTerms: customer.paymentTerms,
      },
      period: { startDate: startDate || null, endDate: endDate || null },
      openingBalance: 0,
      closingBalance: Math.round(runningBalance * 100) / 100,
      lines,
      summary: {
        totalInvoiced: Math.round(totalInvoiced * 100) / 100,
        totalPaid:     Math.round(totalPaid     * 100) / 100,
        outstanding:   Math.round((totalInvoiced - totalPaid) * 100) / 100,
        overdueAmount: Math.round(overdueAmount * 100) / 100,
        invoiceCount:  lines.filter((l) => l.debit > 0).length,
        paymentCount:  lines.filter((l) => l.credit > 0).length,
      },
    };
  }
}

module.exports = new CustomerService();

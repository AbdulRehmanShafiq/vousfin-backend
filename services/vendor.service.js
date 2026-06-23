const vendorRepository = require('../repositories/vendor.repository');
const transactionRepository = require('../repositories/transaction.repository');
const amlScreening = require('./amlScreening.service');
const JournalEntry = require('../models/JournalEntry.model');
const { ApiError } = require('../utils/ApiError');
const { TRANSACTION_TYPES, PAYMENT_STATUS } = require('../config/constants');
const logger = require('../config/logger');
const mongoose = require('mongoose');

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
    // AML screening — fire-and-forget, must not block vendor creation
    amlScreening.screenCounterparty(businessId, {
      counterpartyType: 'vendor',
      counterpartyId: vendor._id,
      counterpartyName: vendor.name || vendor.businessName || '',
    }).catch(console.error);
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
   * Aggregate ERP-style vendor activity statistics.
   * Mirror of customer stats but tracks purchases instead of revenue.
   *
   * @param {string} vendorId
   * @param {string} businessId
   * @returns {Promise<Object>}
   */
  async getVendorStats(vendorId, businessId) {
    const vendor = await vendorRepository.findByBusinessAndId(businessId, vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const vendorObjId   = new mongoose.Types.ObjectId(String(vendorId));
    const businessObjId = new mongoose.Types.ObjectId(String(businessId));

    const [stats] = await JournalEntry.aggregate([
      {
        $match: {
          businessId: businessObjId,
          vendorId: vendorObjId,
          isArchived: { $ne: true },
        },
      },
      {
        $group: {
          _id: null,
          lifetimePurchases: {
            $sum: {
              $cond: [
                { $in: ['$transactionType', [TRANSACTION_TYPES.CREDIT_PURCHASE, TRANSACTION_TYPES.EXPENSE]] },
                '$amount',
                0,
              ],
            },
          },
          lifetimePaymentsMade: {
            $sum: {
              $cond: [
                { $eq: ['$transactionType', TRANSACTION_TYPES.PAYMENT_MADE] },
                '$amount',
                0,
              ],
            },
          },
          billCount: {
            $sum: {
              $cond: [{ $eq: ['$transactionType', TRANSACTION_TYPES.CREDIT_PURCHASE] }, 1, 0],
            },
          },
          paymentCount: {
            $sum: {
              $cond: [{ $eq: ['$transactionType', TRANSACTION_TYPES.PAYMENT_MADE] }, 1, 0],
            },
          },
          overdueCount: {
            $sum: {
              $cond: [{ $eq: ['$paymentStatus', PAYMENT_STATUS.OVERDUE] }, 1, 0],
            },
          },
          billAmountSum: {
            $sum: {
              $cond: [{ $eq: ['$transactionType', TRANSACTION_TYPES.CREDIT_PURCHASE] }, '$amount', 0],
            },
          },
          lastBillDate: {
            $max: {
              $cond: [
                { $eq: ['$transactionType', TRANSACTION_TYPES.CREDIT_PURCHASE] },
                '$transactionDate',
                null,
              ],
            },
          },
          lastPaymentDate: {
            $max: {
              $cond: [
                { $eq: ['$transactionType', TRANSACTION_TYPES.PAYMENT_MADE] },
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
      lifetimePurchases: 0,
      lifetimePaymentsMade: 0,
      billCount: 0,
      paymentCount: 0,
      overdueCount: 0,
      billAmountSum: 0,
      lastBillDate: null,
      lastPaymentDate: null,
      lastActivityDate: null,
    };

    return {
      currentPayable: vendor.currentPayableBalance || 0,
      lifetimePurchases: safe.lifetimePurchases,
      lifetimePaymentsMade: safe.lifetimePaymentsMade,
      billCount: safe.billCount,
      paymentCount: safe.paymentCount,
      overdueCount: safe.overdueCount,
      avgBillValue: safe.billCount > 0
        ? Math.round((safe.billAmountSum / safe.billCount) * 100) / 100
        : 0,
      lastBillDate: safe.lastBillDate,
      lastPaymentDate: safe.lastPaymentDate,
      lastActivityDate: safe.lastActivityDate,
    };
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

  /**
   * Generate a vendor statement — full chronological AP ledger with running balance.
   *
   * Returns:
   *   - vendor: profile info
   *   - lines: [ { date, description, billNumber, type, debit, credit, balance, paymentStatus } ]
   *   - closingBalance: outstanding AP at end of period
   *   - summary: { totalBilled, totalPaid, outstanding, overdueAmount }
   *
   * @param {string} vendorId
   * @param {string} businessId
   * @param {Object} opts - { startDate?, endDate? }
   * @returns {Promise<Object>}
   */
  async getVendorStatement(vendorId, businessId, opts = {}) {
    const vendor = await vendorRepository.findByBusinessAndId(businessId, vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const { startDate, endDate } = opts;
    const filter = {};
    if (startDate) filter.startDate = startDate;
    if (endDate)   filter.endDate   = endDate;

    const txResult = await transactionRepository.findByVendor(businessId, vendorId, filter, { limit: 500, sortBy: 'transactionDate', sortOrder: 1 });
    const entries  = Array.isArray(txResult?.data) ? txResult.data
                   : Array.isArray(txResult)       ? txResult : [];

    let runningBalance = 0;
    const now = Date.now();

    const lines = entries.map((tx) => {
      const isBill    = [TRANSACTION_TYPES.CREDIT_PURCHASE, TRANSACTION_TYPES.INVENTORY_PURCHASE, TRANSACTION_TYPES.CASH_PURCHASE, TRANSACTION_TYPES.EXPENSE].includes(tx.transactionType);
      const isPayment = tx.transactionType === TRANSACTION_TYPES.PAYMENT_MADE;
      const credit = isBill    ? tx.amount : 0;   // Bills increase AP (credit)
      const debit  = isPayment ? tx.amount : 0;   // Payments reduce AP (debit)
      runningBalance += credit - debit;

      const dueRef = tx.dueDate || tx.transactionDate;
      const daysOverdue = dueRef ? Math.max(0, Math.floor((now - new Date(dueRef).getTime()) / 86400000)) : 0;

      return {
        _id:           tx._id,
        date:          tx.transactionDate,
        description:   tx.description,
        billNumber:    tx.invoiceNumber || tx.transactionReference || null,
        type:          tx.transactionType,
        debit:         Math.round(debit  * 100) / 100,
        credit:        Math.round(credit * 100) / 100,
        balance:       Math.round(runningBalance * 100) / 100,
        paymentStatus: tx.paymentStatus || null,
        dueDate:       tx.dueDate || null,
        daysOverdue:   isBill ? daysOverdue : 0,
        remainingBalance: tx.remainingBalance || 0,
      };
    });

    const totalBilled = lines.reduce((s, l) => s + l.credit, 0);
    const totalPaid   = lines.reduce((s, l) => s + l.debit,  0);
    const overdueAmount = lines
      .filter((l) => l.daysOverdue > 0 && l.remainingBalance > 0)
      .reduce((s, l) => s + l.remainingBalance, 0);

    return {
      vendor: {
        _id:           vendor._id,
        vendorName:    vendor.vendorName,
        contactPerson: vendor.contactPerson,
        email:         vendor.email,
        phone:         vendor.phone,
        address:       vendor.address,
        taxId:         vendor.taxId,
        paymentTerms:  vendor.paymentTerms,
      },
      period: { startDate: startDate || null, endDate: endDate || null },
      openingBalance: 0,
      closingBalance: Math.round(runningBalance * 100) / 100,
      lines,
      summary: {
        totalBilled:   Math.round(totalBilled  * 100) / 100,
        totalPaid:     Math.round(totalPaid    * 100) / 100,
        outstanding:   Math.round((totalBilled - totalPaid) * 100) / 100,
        overdueAmount: Math.round(overdueAmount * 100) / 100,
        billCount:     lines.filter((l) => l.credit > 0).length,
        paymentCount:  lines.filter((l) => l.debit  > 0).length,
      },
    };
  }
}

module.exports = new VendorService();

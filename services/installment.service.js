// services/installment.service.js
const installmentPlanRepository = require('../repositories/installmentPlan.repository');
const transactionRepository = require('../repositories/transaction.repository');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const InstallmentPlan = require('../models/InstallmentPlan.model');

class InstallmentService {
  /**
   * Create an installment plan (creates parent transaction + plan + schedule)
   * @param {Object} transactionData - Core transaction fields
   * @param {Object} installmentConfig - Config details (installmentCount, installmentFrequency, downPayment)
   * @param {string} userId - ID of creating user
   * @param {string} ipAddress - Client IP address
   * @returns {Promise<Object>} - Created installment plan
   */
  async createInstallmentPlan(transactionData, installmentConfig, userId, ipAddress) {
    // Dynamic import to avoid circular dependency
    const transactionService = require('./transaction.service');

    if (!transactionData.businessId) {
      throw new ApiError(400, 'Business ID is required');
    }

    // 1. Create the parent transaction (Credit Sale or Credit Purchase depending on party)
    // Installments are inherently credit-based.
    // If customerId is present, transactionType is 'Credit Sale'.
    // If vendorId is present, transactionType is 'Credit Purchase'.
    if (transactionData.customerId) {
      transactionData.transactionType = 'Credit Sale';
    } else if (transactionData.vendorId) {
      transactionData.transactionType = 'Credit Purchase';
    } else {
      throw new ApiError(400, 'Installment plan requires either customerId or vendorId');
    }

    // Set high-level payment status and outstanding fields so transaction creation behaves correctly
    transactionData.dueDate = transactionData.transactionDate || new Date(); // Next due dates will be handled in schedule

    const parentTx = await transactionService.createTransaction(transactionData, userId, ipAddress);

    // 2. Generate Schedule
    const downPayment = installmentConfig.downPayment || 0;
    const remainingAmount = transactionData.amount - downPayment;
    if (remainingAmount < 0) {
      throw new ApiError(400, 'Down payment cannot exceed total amount');
    }

    const installmentCount = installmentConfig.installmentCount;
    if (!installmentCount || installmentCount < 1) {
      throw new ApiError(400, 'Installment count must be at least 1');
    }

    const installmentAmount = Number((remainingAmount / installmentCount).toFixed(2));

    const schedule = InstallmentPlan.generateSchedule(
      transactionData.transactionDate || new Date(),
      installmentCount,
      installmentConfig.installmentFrequency,
      installmentAmount
    );

    // 3. Create the installment plan document
    const plan = await installmentPlanRepository.create({
      businessId: transactionData.businessId,
      linkedTransactionId: parentTx._id,
      customerId: transactionData.customerId || null,
      vendorId: transactionData.vendorId || null,
      totalAmount: transactionData.amount,
      downPayment,
      remainingAmount,
      installmentCount,
      installmentFrequency: installmentConfig.installmentFrequency,
      installmentAmount,
      nextDueDate: schedule[0] ? schedule[0].dueDate : null,
      status: 'active',
      paidInstallments: 0,
      remainingInstallments: installmentCount,
      schedule
    });

    // 4. Link plan back to parent transaction
    await transactionRepository.updateTransaction(parentTx._id, transactionData.businessId, {
      installmentPlanId: plan._id
    });

    // 5. If down payment > 0, record a partial payment immediately
    if (downPayment > 0) {
      const paymentAccountId = transactionData.creditAccountId; // Assume receiving down payment into asset or from cash account
      await transactionService.recordPartialPayment(
        parentTx._id,
        transactionData.businessId,
        {
          amount: downPayment,
          paymentAccountId,
          transactionDate: transactionData.transactionDate || new Date(),
          description: `Down payment for plan ${plan._id}`
        },
        userId,
        ipAddress
      );

      // Record on the plan itself (down payment does not count towards installment schedule items directly,
      // but it reduces remainingAmount. If desired, we can custom mark schedule, but remainingAmount is already reduced).
      plan.remainingAmount = Math.max(0, plan.remainingAmount - downPayment);
      await plan.save();
    }

    logger.info(`Installment plan created for business ${transactionData.businessId}: ${plan._id}`);
    return plan;
  }

  /**
   * Record a payment for an installment plan
   * @param {string} planId - The installment plan ID
   * @param {string} businessId - The business ID
   * @param {Object} paymentData - Payment details
   * @param {string} userId - User ID
   * @param {string} ipAddress - Client IP address
   * @returns {Promise<Object>} - Updated installment plan
   */
  async recordInstallmentPayment(planId, businessId, paymentData, userId, ipAddress) {
    const transactionService = require('./transaction.service');

    const plan = await installmentPlanRepository.findByIdAndBusiness(planId, businessId);
    if (!plan) {
      throw new ApiError(404, 'Installment plan not found');
    }

    if (plan.status === 'completed') {
      throw new ApiError(400, 'Installment plan is already completed');
    }

    // 1. Record the partial payment against the parent transaction
    const childTx = await transactionService.recordPartialPayment(
      plan.linkedTransactionId,
      businessId,
      {
        amount: paymentData.amount,
        paymentAccountId: paymentData.paymentAccountId,
        transactionDate: paymentData.transactionDate || new Date(),
        description: paymentData.description || `Installment payment for plan ${plan._id}`
      },
      userId,
      ipAddress
    );

    // 2. Record on the plan document
    plan.recordPayment(paymentData.amount, childTx._id);
    await plan.save();

    logger.info(`Payment of ${paymentData.amount} recorded for installment plan ${planId}`);
    return plan;
  }

  /**
   * Get an installment plan by ID
   * @param {string} planId - The installment plan ID
   * @param {string} businessId - The business ID
   * @returns {Promise<Object>} - Installment plan object
   */
  async getInstallmentPlan(planId, businessId) {
    const plan = await installmentPlanRepository.findByIdAndBusiness(planId, businessId);
    if (!plan) {
      throw new ApiError(404, 'Installment plan not found');
    }
    return plan;
  }

  /**
   * Get installment plans for a business
   * @param {string} businessId - The business ID
   * @param {Object} filters - Optional filters
   * @returns {Promise<Array>} - List of installment plans
   */
  async getInstallmentsByBusiness(businessId, filters = {}) {
    if (!businessId) {
      throw new ApiError(400, 'Business ID is required');
    }
    return installmentPlanRepository.findByBusiness(businessId, filters);
  }

  /**
   * Get overdue installment plans
   * @param {string} businessId - The business ID
   * @returns {Promise<Array>} - List of overdue plans
   */
  async getOverduePlans(businessId) {
    if (!businessId) {
      throw new ApiError(400, 'Business ID is required');
    }
    return installmentPlanRepository.getOverduePlans(businessId);
  }
}

module.exports = new InstallmentService();

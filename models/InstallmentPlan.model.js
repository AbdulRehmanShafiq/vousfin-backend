// models/InstallmentPlan.model.js
const mongoose = require('mongoose');
const {
  INSTALLMENT_STATUS,
  INSTALLMENT_FREQUENCY,
  PAYMENT_STATUS,
} = require('../config/constants');

/**
 * InstallmentPlan Schema
 * Tracks installment/loan repayment schedules linked to a parent journal entry.
 * Supports asset purchases, loan repayments, vendor and customer installment payments.
 */
const installmentScheduleItemSchema = new mongoose.Schema(
  {
    installmentNumber: {
      type: Number,
      required: true,
      min: 1,
    },
    dueDate: {
      type: Date,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    status: {
      type: String,
      enum: Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.UNPAID,
    },
    paidDate: {
      type: Date,
      default: null,
    },
    paidAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
    },
  },
  { _id: true }
);

const installmentPlanSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    linkedTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      required: true,
    },
    // Optional party references
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
    },
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      default: null,
    },
    // Financial details
    totalAmount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    downPayment: {
      type: Number,
      default: 0,
      min: 0,
    },
    remainingAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    // Plan structure
    installmentCount: {
      type: Number,
      required: true,
      min: 1,
      max: 120, // max 10 years monthly
    },
    installmentFrequency: {
      type: String,
      enum: Object.values(INSTALLMENT_FREQUENCY),
      required: true,
    },
    installmentAmount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    nextDueDate: {
      type: Date,
      default: null,
    },
    // Status tracking
    status: {
      type: String,
      enum: Object.values(INSTALLMENT_STATUS),
      default: INSTALLMENT_STATUS.ACTIVE,
    },
    paidInstallments: {
      type: Number,
      default: 0,
      min: 0,
    },
    remainingInstallments: {
      type: Number,
      required: true,
      min: 0,
    },
    // Full schedule
    schedule: [installmentScheduleItemSchema],
    // Notes
    notes: {
      type: String,
      default: null,
      maxlength: 500,
      trim: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// ===============================
// Indexes
// ===============================
installmentPlanSchema.index({ businessId: 1, status: 1 });
installmentPlanSchema.index({ linkedTransactionId: 1 });
installmentPlanSchema.index({ businessId: 1, nextDueDate: 1 });
installmentPlanSchema.index({ businessId: 1, customerId: 1 });
installmentPlanSchema.index({ businessId: 1, vendorId: 1 });

// ===============================
// Instance Methods
// ===============================

/**
 * Record a payment against the next unpaid installment.
 * @param {number} paidAmount
 * @param {string} transactionId - The journal entry ID for the payment
 * @returns {Object} Updated installment item
 */
installmentPlanSchema.methods.recordPayment = function (paidAmount, transactionId) {
  // Find the next unpaid installment
  const nextUnpaid = this.schedule.find(
    (item) => item.status === PAYMENT_STATUS.UNPAID || item.status === PAYMENT_STATUS.PARTIALLY_PAID
  );

  if (!nextUnpaid) {
    throw new Error('No unpaid installments remaining');
  }

  nextUnpaid.paidAmount += paidAmount;
  nextUnpaid.paidDate = new Date();
  nextUnpaid.transactionId = transactionId;

  if (nextUnpaid.paidAmount >= nextUnpaid.amount) {
    nextUnpaid.status = PAYMENT_STATUS.PAID;
    this.paidInstallments += 1;
    this.remainingInstallments = Math.max(0, this.remainingInstallments - 1);
  } else {
    nextUnpaid.status = PAYMENT_STATUS.PARTIALLY_PAID;
  }

  this.remainingAmount = Math.max(0, this.remainingAmount - paidAmount);

  // Update nextDueDate
  const nextStillUnpaid = this.schedule.find(
    (item) => item.status === PAYMENT_STATUS.UNPAID || item.status === PAYMENT_STATUS.PARTIALLY_PAID
  );
  this.nextDueDate = nextStillUnpaid ? nextStillUnpaid.dueDate : null;

  // Check if plan is completed
  if (this.remainingInstallments === 0 || this.remainingAmount <= 0) {
    this.status = INSTALLMENT_STATUS.COMPLETED;
  }

  return nextUnpaid;
};

// ===============================
// Statics
// ===============================

/**
 * Get overdue installment plans for a business.
 * @param {string} businessId
 * @returns {Promise<Array>}
 */
installmentPlanSchema.statics.getOverduePlans = function (businessId) {
  return this.find({
    businessId,
    status: INSTALLMENT_STATUS.ACTIVE,
    nextDueDate: { $lt: new Date() },
  })
    .populate('linkedTransactionId', 'description amount')
    .populate('customerId', 'fullName')
    .populate('vendorId', 'vendorName')
    .lean();
};

/**
 * Generate installment schedule from plan parameters.
 * @param {Date} startDate
 * @param {number} count
 * @param {string} frequency
 * @param {number} installmentAmount
 * @returns {Array}
 */
installmentPlanSchema.statics.generateSchedule = function (startDate, count, frequency, installmentAmount) {
  const schedule = [];
  let currentDate = new Date(startDate);

  for (let i = 1; i <= count; i++) {
    // Calculate next due date based on frequency
    const dueDate = new Date(currentDate);

    switch (frequency) {
      case INSTALLMENT_FREQUENCY.WEEKLY:
        dueDate.setDate(dueDate.getDate() + 7);
        break;
      case INSTALLMENT_FREQUENCY.BIWEEKLY:
        dueDate.setDate(dueDate.getDate() + 14);
        break;
      case INSTALLMENT_FREQUENCY.MONTHLY:
        dueDate.setMonth(dueDate.getMonth() + 1);
        break;
      case INSTALLMENT_FREQUENCY.QUARTERLY:
        dueDate.setMonth(dueDate.getMonth() + 3);
        break;
      default:
        dueDate.setMonth(dueDate.getMonth() + 1);
    }

    schedule.push({
      installmentNumber: i,
      dueDate: new Date(dueDate),
      amount: installmentAmount,
      status: PAYMENT_STATUS.UNPAID,
      paidDate: null,
      paidAmount: 0,
      transactionId: null,
    });

    currentDate = new Date(dueDate);
  }

  return schedule;
};

// ===============================
// Model Export
// ===============================
const InstallmentPlan = mongoose.model('InstallmentPlan', installmentPlanSchema);

module.exports = InstallmentPlan;

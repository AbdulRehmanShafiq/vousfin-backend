// services/leaseAccounting.service.js — FR-10.2 IFRS-16 Leases
'use strict';
const { ApiError } = require('../utils/ApiError');
const Lease = require('../models/Lease.model');
const ledgerPosting = require('./ledgerPosting.service');
const accountRepository = require('../repositories/account.repository');

class LeaseAccountingService {
  async createLease(businessId, data, actor) {
    const lease = await Lease.create({ businessId, ...data, createdBy: actor._id || actor.id || null });
    return lease;
  }

  async listLeases(businessId) {
    return Lease.find({ businessId }).lean();
  }

  async getLease(id, businessId) {
    const lease = await Lease.findOne({ _id: id, businessId }).lean();
    if (!lease) throw new ApiError(404, 'Lease not found');
    return lease;
  }

  /**
   * Pure IFRS-16 amortization schedule — no DB access.
   * monthlyRate = (1 + annualRate)^(1/12) - 1
   * initialLiability = PV of lease payments
   * initialRouAsset = initialLiability (IFRS-16 default — no initial direct costs included)
   */
  computeAmortizationSchedule(lease) {
    const { leaseTerm, monthlyPayment, discountRate } = lease;
    const monthlyRate = Math.pow(1 + discountRate, 1 / 12) - 1;

    // Present value of an annuity-due (payments at end of each period)
    let presentValue = 0;
    for (let n = 1; n <= leaseTerm; n++) {
      presentValue += monthlyPayment / Math.pow(1 + monthlyRate, n);
    }
    presentValue = Math.round(presentValue * 100) / 100;

    const initialRouAsset = presentValue;
    const rouDepreciation = Math.round((initialRouAsset / leaseTerm) * 100) / 100;

    const schedule = [];
    let openingLiability = presentValue;

    for (let period = 1; period <= leaseTerm; period++) {
      const interestCharge = Math.round(openingLiability * monthlyRate * 100) / 100;
      const principalRepayment = Math.round((monthlyPayment - interestCharge) * 100) / 100;
      const closingLiability = Math.round((openingLiability - principalRepayment) * 100) / 100;

      schedule.push({
        period,
        openingLiability: Math.round(openingLiability * 100) / 100,
        interestCharge,
        payment: monthlyPayment,
        principalRepayment,
        closingLiability: Math.max(0, closingLiability),
        rouDepreciation,
      });

      openingLiability = Math.max(0, closingLiability);
    }

    return { initialRouAsset, initialLiability: presentValue, schedule };
  }

  /**
   * Post this month's amortization entry for a lease.
   * DR: ROU depreciation expense / CR: Accumulated Depreciation
   * DR: Finance Cost (interest) / CR: Lease Liability
   */
  async postMonthlyAmortization(leaseId, businessId) {
    const lease = await Lease.findOne({ _id: leaseId, businessId });
    if (!lease) throw new ApiError(404, 'Lease not found');
    if (lease.status !== 'active') throw new ApiError(400, 'Cannot amortize a non-active lease');

    // Check if already posted this month
    if (lease.lastAmortizationDate) {
      const last = new Date(lease.lastAmortizationDate);
      const now = new Date();
      if (last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth()) {
        throw new ApiError(409, 'Already posted this month');
      }
    }

    const { schedule, initialRouAsset } = this.computeAmortizationSchedule(lease);

    // Determine which period we're in
    const start = new Date(lease.commencementDate);
    const now = new Date();
    const monthsElapsed =
      (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
    const periodIndex = Math.max(0, Math.min(monthsElapsed, schedule.length - 1));
    const row = schedule[periodIndex];

    // Look up or fall back to generic accounts
    const findAccount = async (code) => {
      try {
        const accts = await accountRepository.findAll({ businessId, accountCode: code }, { limit: 1 });
        return accts.data?.[0]?._id || null;
      } catch {
        return null;
      }
    };

    // Account codes: 5100 Depreciation Expense, 1130 Accumulated Depreciation, 5200 Finance Cost, 2150 Lease Liability
    const depExpenseId  = lease.rouAssetAccountId || await findAccount('5100') || await findAccount('5000');
    const accumDepId    = await findAccount('1130') || await findAccount('1120');
    const finCostId     = await findAccount('5200') || await findAccount('5100');
    const leaseLiabId   = lease.leaseLiabilityAccountId || await findAccount('2150') || await findAccount('2100');

    if (!depExpenseId || !accumDepId || !finCostId || !leaseLiabId) {
      throw new ApiError(422, 'Required accounts not found. Please ensure your chart of accounts includes depreciation and liability accounts.');
    }

    const lines = [
      { accountId: depExpenseId, type: 'debit',  amount: row.rouDepreciation, description: `IFRS-16 ROU depreciation — ${lease.assetName} period ${row.period}` },
      { accountId: accumDepId,   type: 'credit', amount: row.rouDepreciation, description: `IFRS-16 accumulated depreciation — ${lease.assetName} period ${row.period}` },
      { accountId: finCostId,    type: 'debit',  amount: row.interestCharge,  description: `IFRS-16 finance cost — ${lease.assetName} period ${row.period}` },
      { accountId: leaseLiabId,  type: 'credit', amount: row.interestCharge,  description: `IFRS-16 lease liability reduction — ${lease.assetName} period ${row.period}` },
    ];

    const je = await ledgerPosting.postCompoundJournal({
      businessId,
      transactionDate: new Date(),
      description: `IFRS-16 lease amortization — ${lease.assetName} (period ${row.period}/${lease.leaseTerm})`,
      transactionType: 'journal_entry',
      transactionSource: 'system_generated',
      inputMethod: 'system',
      lines,
      idempotencyKey: `lease:${leaseId}:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
    });

    lease.lastAmortizationDate = new Date();
    await lease.save();

    return je;
  }

  async terminateLease(id, businessId) {
    const lease = await Lease.findOne({ _id: id, businessId });
    if (!lease) throw new ApiError(404, 'Lease not found');
    lease.status = 'terminated';
    await lease.save();
    return lease;
  }
}

module.exports = new LeaseAccountingService();

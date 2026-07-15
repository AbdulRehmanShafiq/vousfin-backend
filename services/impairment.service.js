// services/impairment.service.js — FR-10.2 IAS-36 Impairment
'use strict';
const { ApiError } = require('../utils/ApiError');
const ImpairmentCheck = require('../models/ImpairmentCheck.model');
const ledgerPosting = require('./ledgerPosting.service');
const accountRepository = require('../repositories/account.repository');

class ImpairmentService {
  static IAS36_INDICATORS = [
    'Asset market value has declined significantly',
    'Business environment has changed adversely',
    'Asset is idle or plans to discontinue use',
    'Physical damage or obsolescence observed',
    'Asset performance is worse than expected',
    'Market interest rates have increased significantly',
    'Net assets of the business exceed market capitalisation',
    'Asset has become technologically outdated',
    'Regulatory or government action affects the asset',
    'Economic performance of the asset is worse than budgeted',
  ];

  async createAssessment(businessId, data, actor) {
    const impairmentLoss = Math.max(0, (data.carryingAmount || 0) - (data.recoverableAmount || 0));
    const status = impairmentLoss > 0 ? 'assessed' : 'no_impairment';

    const check = await ImpairmentCheck.create({
      businessId,
      assetName: data.assetName,
      assetAccountId: data.assetAccountId || null,
      carryingAmount: data.carryingAmount,
      recoverableAmount: data.recoverableAmount,
      impairmentLoss,
      indicators: data.indicators || [],
      assessmentDate: data.assessmentDate || new Date(),
      status,
      createdBy: actor._id || actor.id || null,
    });
    return check;
  }

  async listAssessments(businessId) {
    return ImpairmentCheck.find({ businessId }).sort({ assessmentDate: -1 }).lean();
  }

  async postImpairmentLoss(id, businessId) {
    const check = await ImpairmentCheck.findOne({ _id: id, businessId });
    if (!check) throw new ApiError(404, 'Impairment assessment not found');
    if (check.impairmentLoss === 0) throw new ApiError(400, 'No impairment loss to post');
    if (check.status === 'loss_posted') throw new ApiError(409, 'Impairment loss already posted');

    // Find impairment loss expense account and asset account
    const findAccount = async (code) => {
      try {
        const accts = await accountRepository.findAll({ businessId, accountCode: code }, { limit: 1 });
        return accts.data?.[0]?._id || null;
      } catch {
        return null;
      }
    };

    // 5300 Impairment Loss (expense), or fall back to 5000 general expense
    const impairmentExpenseId = await findAccount('5300') || await findAccount('5000');
    const assetAccountId = check.assetAccountId || await findAccount('1200') || await findAccount('1100');

    if (!impairmentExpenseId || !assetAccountId) {
      throw new ApiError(422, 'Required accounts not found. Ensure your chart of accounts includes an impairment loss expense account.');
    }

    const je = await ledgerPosting.postCompoundJournal({
      businessId,
      transactionDate: new Date(),
      description: `IAS-36 impairment loss — ${check.assetName}`,
      // One impairment entry per check.
      idempotencyKey: `impairment:${check._id}`,
      transactionType: 'journal_entry',
      transactionSource: 'system_generated',
      inputMethod: 'system',
      lines: [
        { accountId: impairmentExpenseId, type: 'debit',  amount: check.impairmentLoss, description: `Impairment loss — ${check.assetName}` },
        { accountId: assetAccountId,      type: 'credit', amount: check.impairmentLoss, description: `Asset carrying value reduced — ${check.assetName}` },
      ],
    });

    check.status = 'loss_posted';
    await check.save();

    return je;
  }
}

module.exports = new ImpairmentService();

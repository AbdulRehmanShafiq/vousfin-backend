// services/amlScreening.service.js — FR-10.3 AML/KYC Screening
'use strict';
const { ApiError } = require('../utils/ApiError');
const CounterpartyScreening = require('../models/CounterpartyScreening.model');

class AmlScreeningService {
  static RISK_KEYWORDS = [
    'cash', 'anonymous', 'offshore', 'shell', 'nominee',
    'bearer', 'unknown', 'informal', 'hawala', 'cryptocurrency',
  ];

  /**
   * Screen a counterparty. Upserts by {businessId, counterpartyId}.
   */
  async screenCounterparty(businessId, { counterpartyType, counterpartyId, counterpartyName, transactionAmount }) {
    const nameLower = (counterpartyName || '').toLowerCase();
    const flags = [];

    // Keyword scan
    for (const kw of AmlScreeningService.RISK_KEYWORDS) {
      if (nameLower.includes(kw)) flags.push(`KEYWORD_${kw.toUpperCase()}`);
    }

    let riskScore = Math.min(flags.length * 15, 100);

    // High-value transaction flag
    const threshold = 500000;
    if (transactionAmount && transactionAmount >= threshold) {
      flags.push('HIGH_VALUE_TRANSACTION');
      riskScore = Math.min(riskScore + 20, 100);
    }

    const result = riskScore >= 30 ? 'flagged' : 'clear';

    const doc = await CounterpartyScreening.findOneAndUpdate(
      { businessId, counterpartyId },
      {
        $set: {
          businessId,
          counterpartyType,
          counterpartyId,
          counterpartyName,
          screeningDate: new Date(),
          result,
          riskScore,
          flags,
          threshold,
        },
      },
      { upsert: true, new: true },
    );

    return doc;
  }

  async listScreenings(businessId, { result } = {}) {
    const filter = { businessId };
    if (result) filter.result = result;
    return CounterpartyScreening.find(filter).sort({ screeningDate: -1 });
  }

  async getScreening(id, businessId) {
    const s = await CounterpartyScreening.findOne({ _id: id, businessId });
    if (!s) throw new ApiError(404, 'Screening record not found');
    return s;
  }

  async addJustification(id, businessId, { justification, reviewedBy }) {
    const s = await CounterpartyScreening.findOne({ _id: id, businessId });
    if (!s) throw new ApiError(404, 'Screening record not found');

    s.justification = justification || '';
    s.reviewedBy = reviewedBy || null;
    s.reviewedAt = new Date();
    if (s.result === 'flagged') s.strDrafted = true;
    await s.save();
    return s;
  }

  /**
   * Return a plain STR draft object — no DB write.
   */
  async draftSTR(id, businessId) {
    const doc = await CounterpartyScreening.findOne({ _id: id, businessId });
    if (!doc) throw new ApiError(404, 'Screening record not found');
    const s = doc.toObject ? doc.toObject() : doc;

    const dateStr = new Date(s.screeningDate).toISOString().split('T')[0];
    return {
      businessId: s.businessId,
      counterpartyName: s.counterpartyName,
      flags: s.flags,
      riskScore: s.riskScore,
      screeningDate: s.screeningDate,
      draftText: `Suspicious Transaction Report — ${s.counterpartyName} flagged on ${dateStr} with risk score ${s.riskScore}. Flags: ${s.flags.join(', ')}. Requires compliance officer review.`,
    };
  }
}

module.exports = new AmlScreeningService();

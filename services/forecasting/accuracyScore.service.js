// services/forecasting/accuracyScore.service.js
//
// Forecast Platform — Stage A1. Accuracy & Confidence score.
//
// Turns the accuracy the platform already MEASURES (ForecastAccuracy = realized
// predicted-vs-actual, ModelRegistry = backtest skill) into one honest, plain
// number a business owner can trust:
//   • accuracyPct — measured accuracy on the metric (100 − MAPE; backtest sMAPE
//     as a fallback before realized actuals exist)
//   • confidence  — 0–100, blended from data sufficiency, backtest skill vs the
//     naive baseline, interval calibration, and an anomaly penalty
//   • label       — High / Medium / Low / Insufficient
// We NEVER assert a number we can't back: with no history it returns
// "Insufficient" and tells the user to add data.
//
'use strict';
const mongoose = require('mongoose');
const ForecastAccuracy = require('../../models/ForecastAccuracy.model');
const ModelRegistry = require('../../models/ModelRegistry.model');
const { ApiError } = require('../../utils/ApiError');
const logger = require('../../config/logger');

const oid = (id) => new mongoose.Types.ObjectId(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

class AccuracyScoreService {
  /**
   * Pure scoring — exposed for tests. Combines realized + backtest evidence.
   * @param {Object} in { mape, coverage, realizedPoints, mase, smape, gatePassed, dataPoints, anomalyRisk }
   */
  compute({ mape, coverage, realizedPoints = 0, mase, smape, gatePassed, dataPoints = 0, anomalyRisk = 0 } = {}) {
    const hasRealized = realizedPoints >= 3 && mape != null;
    const hasBacktest = mase != null || smape != null;

    if (!hasRealized && !hasBacktest) {
      return {
        accuracyPct: null, confidence: 0, label: 'Insufficient',
        basis: 'No forecast history yet — record a few months of transactions to unlock this.',
        mape: null, coverage: null, source: 'none',
      };
    }

    // ── measured accuracy ──────────────────────────────────────────────────
    const accuracyPct = hasRealized
      ? clamp(100 - mape, 0, 99)
      : clamp(100 - (smape != null ? smape : 50), 0, 95);

    // ── confidence: data sufficiency base, adjusted by skill/calibration/risk ─
    const months = dataPoints || 0;
    let conf = months <= 0 ? 30 : months <= 2 ? 45 : months <= 5 ? 60 : 78;
    if (gatePassed) conf += 8;                                   // beats the naive baseline
    if (mase != null && mase < 0.7) conf += 8;                   // clearly better than naive
    if (hasRealized && coverage != null) {
      if (coverage >= 0.8 && coverage <= 0.97) conf += 6;        // well-calibrated intervals
      else if (coverage < 0.6) conf -= 12;                       // intervals too tight
    }
    conf -= Math.round((anomalyRisk || 0) * 15);                 // fraud/anomaly contamination
    conf = clamp(conf, 5, 97);

    const label = conf >= 70 ? 'High' : conf >= 54 ? 'Medium' : 'Low';
    const basis = hasRealized
      ? `Measured on your last ${realizedPoints} realized forecast${realizedPoints > 1 ? 's' : ''}.`
      : `Estimated from a backtest over ${months} month${months !== 1 ? 's' : ''} (no realized actuals yet).`;

    return {
      accuracyPct: r2(accuracyPct), confidence: Math.round(conf), label, basis,
      mape: hasRealized ? r2(mape) : null,
      coverage: coverage != null ? r2(coverage) : null,
      source: hasRealized ? 'realized' : 'backtest',
    };
  }

  /** DB-backed score for a tenant + target. */
  async score(businessId, target = 'Revenue', granularity = 'monthly') {
    if (!mongoose.Types.ObjectId.isValid(businessId)) throw new ApiError(400, 'Invalid businessId');
    const key = `${target}-${granularity}`;

    const [accRows, reg, anomalyRisk] = await Promise.all([
      ForecastAccuracy.aggregate([
        { $match: { businessId: oid(businessId), target } },
        { $group: { _id: null, mape: { $avg: '$pctError' }, coverage: { $avg: { $cond: ['$withinInterval', 1, 0] } }, points: { $sum: 1 } } },
      ]),
      ModelRegistry.findOne({ businessId, key }).sort({ version: -1 }).lean(),
      this._anomaly(businessId),
    ]);

    const a = accRows[0] || {};
    const result = this.compute({
      mape: a.mape, coverage: a.coverage, realizedPoints: a.points || 0,
      mase: reg?.modelMase, smape: reg?.backtest?.smape, gatePassed: reg?.gatePassed,
      dataPoints: reg?.trainWindow?.points || 0, anomalyRisk,
    });
    return { target, granularity, ...result, modelVersion: reg?.version || null, generatedAt: new Date().toISOString() };
  }

  async _anomaly(businessId) {
    try {
      const lstm = require('./lstmForecastService');
      const r = await lstm.fetchAnomalyRisk(businessId);
      return r?.riskScore || 0;
    } catch (e) { logger.warn(`[accuracyScore] anomaly read failed: ${e.message}`); return 0; }
  }
}

module.exports = new AccuracyScoreService();

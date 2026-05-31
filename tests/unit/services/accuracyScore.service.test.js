/**
 * tests/unit/services/accuracyScore.service.test.js
 *
 * Forecast Platform — A1. Accuracy & Confidence score: honest measured accuracy,
 * confidence blending, and the "insufficient data" guard.
 */
'use strict';

jest.mock('../../../models/ForecastAccuracy.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../../models/ModelRegistry.model', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/forecasting/lstmForecastService', () => ({ fetchAnomalyRisk: jest.fn() }));

const mongoose = require('mongoose');
const svc = require('../../../services/forecasting/accuracyScore.service');
const ForecastAccuracy = require('../../../models/ForecastAccuracy.model');
const ModelRegistry = require('../../../models/ModelRegistry.model');
const lstm = require('../../../services/forecasting/lstmForecastService');

const BIZ = '507f1f77bcf86cd799439060';
beforeAll(() => Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, get: () => 1 }));
beforeEach(() => { jest.clearAllMocks(); lstm.fetchAnomalyRisk.mockResolvedValue({ riskScore: 0 }); });

describe('compute (pure)', () => {
  it('returns Insufficient with no history (never asserts a number)', () => {
    const r = svc.compute({});
    expect(r.label).toBe('Insufficient');
    expect(r.accuracyPct).toBeNull();
    expect(r.basis).toMatch(/record/i);
  });

  it('reports high measured accuracy + High confidence for a strong realized record', () => {
    const r = svc.compute({ mape: 8, coverage: 0.9, realizedPoints: 9, mase: 0.6, gatePassed: true, dataPoints: 18, anomalyRisk: 0 });
    expect(r.accuracyPct).toBe(92);               // 100 − 8
    expect(r.label).toBe('High');
    expect(r.source).toBe('realized');
  });

  it('falls back to backtest sMAPE before realized actuals exist', () => {
    const r = svc.compute({ smape: 18, mase: 0.8, gatePassed: true, dataPoints: 10 });
    expect(r.accuracyPct).toBe(82);               // 100 − 18
    expect(r.source).toBe('backtest');
  });

  it('penalizes confidence for thin data, anomalies, and poorly-calibrated intervals', () => {
    const strong = svc.compute({ mape: 10, coverage: 0.9, realizedPoints: 12, mase: 0.6, gatePassed: true, dataPoints: 24, anomalyRisk: 0 });
    const fraud  = svc.compute({ mape: 10, coverage: 0.9, realizedPoints: 12, mase: 0.6, gatePassed: true, dataPoints: 24, anomalyRisk: 0.8 });
    const tight  = svc.compute({ mape: 10, coverage: 0.4, realizedPoints: 12, mase: 0.6, gatePassed: true, dataPoints: 24, anomalyRisk: 0 });
    const thin   = svc.compute({ mape: 10, coverage: 0.9, realizedPoints: 3, mase: 0.9, gatePassed: false, dataPoints: 2, anomalyRisk: 0 });
    expect(fraud.confidence).toBeLessThan(strong.confidence);
    expect(tight.confidence).toBeLessThan(strong.confidence);
    expect(thin.confidence).toBeLessThan(strong.confidence);
  });
});

describe('score (DB-backed)', () => {
  it('blends the realized accuracy aggregate, registry skill, and anomaly risk', async () => {
    ForecastAccuracy.aggregate.mockResolvedValue([{ mape: 9, coverage: 0.88, points: 8 }]);
    ModelRegistry.findOne.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve({ version: 4, modelMase: 0.65, gatePassed: true, backtest: { smape: 12 }, trainWindow: { points: 18 } }) }) });
    const r = await svc.score(BIZ, 'Revenue');
    expect(r.target).toBe('Revenue');
    expect(r.accuracyPct).toBe(91);               // 100 − 9
    expect(r.label).toBe('High');
    expect(r.modelVersion).toBe(4);
  });

  it('returns Insufficient when there is neither realized accuracy nor a registered model', async () => {
    ForecastAccuracy.aggregate.mockResolvedValue([]);
    ModelRegistry.findOne.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve(null) }) });
    const r = await svc.score(BIZ, 'Revenue');
    expect(r.label).toBe('Insufficient');
  });
});

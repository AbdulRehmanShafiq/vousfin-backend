// services/forecasting/explainability.service.js
//
// Forecast Platform — F7. Explainability + what-if orchestration.
//
//   explain()  → decompose the served forecast into (a) which ENSEMBLE MEMBER
//                drove it and (b) which input DRIVERS (recent values / trend)
//                moved it, via exact linear attribution on the AR member, then
//                render a plain-English narrative.
//   scenario() → refit the ensemble on a shocked series and compare paths.
//
'use strict';
const ensemble = require('./ensemble');
const ensembleForecast = require('./ensembleForecast.service');
const regression = require('./regression');
const attribution = require('./explainability/attribution');
const scenario = require('./explainability/scenario');

const METRIC_KEY = { Revenue: 'revenue', Expenses: 'expenses', 'Net Cash Flow': 'profit', Profitability: 'profit' };
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

async function _series(businessId, target) {
  const lstm = require('./lstmForecastService');
  const monthly = await lstm.fetchMonthlyData(businessId, 24);
  const metric = METRIC_KEY[target] || 'revenue';
  return monthly.map((m) => m[metric]).filter((v) => v != null && v >= 0);
}

function _periodFor(series) { return series.filter((v) => v > 0).length >= 6 ? 3 : 2; }

class ExplainabilityService {
  /** Decompose a forecast into member + driver attributions with a narrative. */
  async explain(businessId, target = 'Revenue', horizon = 6) {
    const series = await _series(businessId, target);
    if (series.length < 4) return { target, insufficient: true };
    const period = _periodFor(series);

    // ── ensemble member contributions (which model drove the number) ──
    const { weights, members } = ensemble.buildEnsemble(series, { horizon, period });
    const memberPoint = {};
    for (const [name, fn] of Object.entries(members)) memberPoint[name] = (fn(series, 1) || [])[0] || 0;
    const memberAttribution = attribution.ensembleAttribution(weights, memberPoint);

    // ── exact linear attribution on the AR member (which inputs moved it) ──
    const n = series.length;
    const order = Math.min(2, Math.max(1, n - 2));
    const scale = Math.max(...series.map(Math.abs), 1);
    const coef = regression.fitAR(series, order, 1e-3 * scale);
    const featureVec = Array.from({ length: order }, (_, k) => series[n - 1 - k]);
    const names = Array.from({ length: order }, (_, k) => `${target} (t-${k + 1})`);
    const driverAttribution = attribution.linearContributions(coef, featureVec, names);

    const narrative = this._narrative(target, memberAttribution, driverAttribution, series);
    return {
      target, horizon,
      memberContributions: memberAttribution.members,
      drivers: driverAttribution.drivers,
      base: driverAttribution.base,
      narrative,
    };
  }

  /** What-if: refit the ensemble on a shocked series and compare to the base. */
  async scenario(businessId, target = 'Revenue', horizon = 6, shocks = {}) {
    const series = await _series(businessId, target);
    if (series.length < 4) return { target, insufficient: true };
    const period = _periodFor(series);
    const base = ensembleForecast.computeFromSeries(series, { horizon, period });

    const mult = target === 'Expenses'
      ? (Number(shocks.expenseMultiplier) || 1)
      : (Number(shocks.revenueMultiplier) || 1);
    const build = (s) => ensemble.buildEnsemble(s, { horizon, period }).forecastFn;
    const scenarioPred = scenario.whatIf(series, build, (v) => v * mult, horizon);

    return {
      target, horizon, shocks: { multiplier: mult, ...shocks },
      base: base ? base.predicted : [],
      scenario: scenarioPred,
      comparison: base ? scenario.compare(base.predicted, scenarioPred) : [],
    };
  }

  /** Plain-English driver narrative. @private */
  _narrative(target, memberAttr, driverAttr, series) {
    const topMember = memberAttr.members[0];
    const topDriver = driverAttr.drivers[0];
    const n = series.length;
    const momentum = (n >= 2 && series[n - 2]) ? ((series[n - 1] - series[n - 2]) / series[n - 2]) * 100 : 0;
    const dir = momentum >= 0 ? 'rising' : 'falling';

    const parts = [];
    if (topMember) {
      parts.push(`The ${target.toLowerCase()} forecast is led by the ${this._memberLabel(topMember.name)} model (${topMember.pct}% of the projected value).`);
    }
    if (topDriver) {
      parts.push(`Its strongest signal is the most recent ${target.toLowerCase()} (${topDriver.name}), ${topDriver.direction === 'up' ? 'pushing the forecast up' : 'weighing it down'}.`);
    }
    parts.push(`Recent ${target.toLowerCase()} is ${dir} (${momentum >= 0 ? '+' : ''}${r2(momentum)}% month-on-month), which the model carries forward.`);
    return parts.join(' ');
  }

  _memberLabel(name) {
    return ({
      holtWinters: 'Holt-Winters seasonal', drift: 'trend (drift)',
      seasonalNaive: 'seasonal-naive', arRegression: 'autoregressive (AR)',
    })[name] || name;
  }
}

module.exports = new ExplainabilityService();

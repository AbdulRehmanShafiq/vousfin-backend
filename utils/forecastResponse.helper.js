const { generateInsights } = require('../services/forecasting/forecastingService');

const METRIC_API_TO_TARGET = {
  revenue: 'Revenue',
  expenses: 'Expenses',
  netCashFlow: 'Net Cash Flow',
};

function monthLabelToDate(label, index) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const idx = months.indexOf(label);
  const month = idx >= 0 ? idx : index % 12;
  const year = new Date().getFullYear();
  return new Date(year, month, 1).toISOString();
}

function seriesToChartPoints(values, labels, startIndex = 0) {
  return values.map((value, i) => {
    const label = labels[startIndex + i] || `M${startIndex + i + 1}`;
    return {
      period: label,
      date: monthLabelToDate(label, startIndex + i),
      value,
    };
  });
}

function insightsToList(insightsRaw) {
  if (!insightsRaw) return [];
  return [
    { type: insightsRaw.trend?.isPositive ? 'info' : 'warning', text: insightsRaw.trend?.text },
    { type: 'info', text: insightsRaw.growth?.text },
    { type: insightsRaw.risk?.isHigh ? 'warning' : 'info', text: insightsRaw.risk?.text },
    { type: 'info', text: insightsRaw.recommendation?.text },
  ].filter((item) => item.text);
}

/**
 * Transform ML forecast output into API response for React charts (historical + predicted arrays).
 */
function formatForecastApiResponse(metric, horizon, forecastResult) {
  const { historical, predicted, labels = [], upper, lower, confidence, target } = forecastResult;
  const historicalPoints = seriesToChartPoints(historical, labels, 0);
  const predictedPoints = seriesToChartPoints(predicted, labels, historical.length);
  const insightsRaw = generateInsights(forecastResult);

  const confidenceScore =
    confidence?.[0] === 'High' ? '92%' : confidence?.[0] === 'Medium' ? '85%' : '78%';

  return {
    metric: metric || target,
    target,
    months: horizon,
    historical: historicalPoints,
    predicted: predictedPoints,
    forecast: predictedPoints,
    confidenceIntervals: predicted.map((v, i) => [lower[i], upper[i]]),
    confidenceScore,
    insights: insightsToList(insightsRaw),
    raw: forecastResult,
  };
}

module.exports = { METRIC_API_TO_TARGET, formatForecastApiResponse };

/**
 * @file index.js
 * @description Entry point for the vousFin Forecasting module.
 *              Initializes the data loader on require() and exports the router.
 */

const { initialize } = require('./dataLoader');
const forecastingRoutes = require('./forecastingRoutes');

// Initialize data loader eagerly so CSV data is in memory at startup
try {
  initialize();
} catch (err) {
  console.error('[Forecasting] Failed to initialize:', err.message);
}

module.exports = forecastingRoutes;

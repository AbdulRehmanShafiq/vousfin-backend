// routes/index.js
const express = require('express');
const router = express.Router();

// Import v1 route modules
const authRoutes = require('./v1/auth.routes');
const businessRoutes = require('./v1/business.routes');
const transactionRoutes = require('./v1/transaction.routes');
const reportRoutes = require('./v1/report.routes');
const dashboardRoutes = require('./v1/dashboard.routes');
const aiRoutes = require('./v1/ai.routes');
const adminRoutes = require('./v1/admin.routes');
const customerRoutes = require('./v1/customer.routes');
const vendorRoutes = require('./v1/vendor.routes');
const forecastRoutes = require('./v1/forecast.routes');
const inventoryRoutes  = require('./v1/inventory.routes');
const fiscalYearRoutes = require('./v1/fiscalYear.routes');
const fxRateRoutes     = require('./v1/fxRate.routes');
const taxRoutes        = require('./v1/tax.routes');        // Phase 5.4

// Mount v1 routes under /api/v1
router.use('/auth', authRoutes);
router.use('/business', businessRoutes);
router.use('/transactions', transactionRoutes);
router.use('/reports', reportRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/ai', aiRoutes);
router.use('/admin', adminRoutes);
router.use('/customers', customerRoutes);
router.use('/vendors', vendorRoutes);
router.use('/forecast', forecastRoutes);
router.use('/inventory',   inventoryRoutes);
router.use('/fiscal-years', fiscalYearRoutes);
router.use('/fx-rates',    fxRateRoutes);
router.use('/tax',         taxRoutes);            // Phase 5.4

// Health check endpoint (versioned)
router.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'API is healthy',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
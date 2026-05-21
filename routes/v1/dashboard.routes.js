const express = require('express');
const router = express.Router();
const dashboardController = require('../../controllers/dashboard.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate = require('../../middleware/validate.middleware');
const { kpiSchema } = require('../../validations/report.validation'); // reuse report validation

router.use(authMiddleware, requireBusiness);

router.get('/kpis', validate(kpiSchema, 'query'), dashboardController.getKPIs);
router.get('/revenue-vs-expenses', validate(kpiSchema, 'query'), dashboardController.getRevenueVsExpenses);
router.get('/cash-flow-trend', validate(kpiSchema, 'query'), dashboardController.getCashFlowTrend);
router.get('/all', validate(kpiSchema, 'query'), dashboardController.getAllDashboardData);

module.exports = router;
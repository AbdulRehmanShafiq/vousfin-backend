const express = require('express');
const router = express.Router();
const reportController = require('../../controllers/report.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate = require('../../middleware/validate.middleware');
const {
  incomeStatementSchema,
  balanceSheetSchema,
  cashFlowSchema,
  kpiSchema,
  exportReportSchema,
  trialBalanceSchema,
} = require('../../validations/report.validation');

router.use(authMiddleware, requireBusiness);

router.get('/income-statement', validate(incomeStatementSchema, 'query'), reportController.getIncomeStatement);
router.get('/balance-sheet', validate(balanceSheetSchema, 'query'), reportController.getBalanceSheet);
router.get('/cash-flow', validate(cashFlowSchema, 'query'), reportController.getCashFlowStatement);
router.get('/trial-balance', validate(trialBalanceSchema, 'query'), reportController.getTrialBalance);
router.get('/kpi', validate(kpiSchema, 'query'), reportController.getKPISummary);
router.get('/export', validate(exportReportSchema, 'query'), reportController.exportReport);

module.exports = router;
const express    = require('express');
const router     = express.Router();
const ctrl       = require('../../controllers/report.controller');
const { authMiddleware }   = require('../../middleware/auth.middleware');
const { requireBusiness }  = require('../../middleware/business.middleware');
const validate   = require('../../middleware/validate.middleware');
const {
  incomeStatementSchema,
  balanceSheetSchema,
  cashFlowSchema,
  kpiSchema,
  exportReportSchema,
  trialBalanceSchema,
  generalLedgerSchema,
  agingReportSchema,
  liabilityReportSchema,
  comparativeIncomeSchema,
  comparativeBalanceSchema,
} = require('../../validations/report.validation');

router.use(authMiddleware, requireBusiness);

// ── Core financial statements ────────────────────────────────────────────────
router.get('/income-statement',    validate(incomeStatementSchema,    'query'), ctrl.getIncomeStatement);
router.get('/balance-sheet',       validate(balanceSheetSchema,       'query'), ctrl.getBalanceSheet);
router.get('/cash-flow',           validate(cashFlowSchema,           'query'), ctrl.getCashFlowStatement);
router.get('/trial-balance',       validate(trialBalanceSchema,       'query'), ctrl.getTrialBalance);

// ── Ledger & detail ──────────────────────────────────────────────────────────
router.get('/general-ledger',      validate(generalLedgerSchema,      'query'), ctrl.getGeneralLedger);

// ── AR/AP aging ──────────────────────────────────────────────────────────────
router.get('/aging',               validate(agingReportSchema,        'query'), ctrl.getAgingReport);

// ── Tax ──────────────────────────────────────────────────────────────────────
router.get('/tax-summary',         ctrl.getTaxSummary);

// ── Liability ────────────────────────────────────────────────────────────────
router.get('/liabilities',         validate(liabilityReportSchema,    'query'), ctrl.getLiabilityReport);

// ── Comparative ──────────────────────────────────────────────────────────────
router.get('/comparative/income',   validate(comparativeIncomeSchema,  'query'), ctrl.getComparativeIncomeStatement);
router.get('/comparative/balance',  validate(comparativeBalanceSchema, 'query'), ctrl.getComparativeBalanceSheet);

// ── KPI & export ─────────────────────────────────────────────────────────────
router.get('/kpi',                 validate(kpiSchema,                'query'), ctrl.getKPISummary);
router.get('/export',              validate(exportReportSchema,       'query'), ctrl.exportReport);

module.exports = router;

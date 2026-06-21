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
  equityStatementSchema,
  revenueNotesSchema,
} = require('../../validations/report.validation');

router.use(authMiddleware, requireBusiness);

// ── Core financial statements ────────────────────────────────────────────────
router.get('/income-statement',    validate(incomeStatementSchema,    'query'), ctrl.getIncomeStatement);
// Common aliases — both resolve to the same income-statement handler
router.get('/profit-loss',         validate(incomeStatementSchema,    'query'), ctrl.getIncomeStatement);
router.get('/profit-and-loss',     validate(incomeStatementSchema,    'query'), ctrl.getIncomeStatement);
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

// ── Equity & IFRS notes ───────────────────────────────────────────────────────
router.get('/equity',              validate(equityStatementSchema,    'query'), ctrl.getStatementOfChangesInEquity);
router.get('/notes/revenue',       validate(revenueNotesSchema,       'query'), ctrl.getRevenueNotes);

// ── KPI & export ─────────────────────────────────────────────────────────────
router.get('/kpi',                 validate(kpiSchema,                'query'), ctrl.getKPISummary);
router.get('/export',              validate(exportReportSchema,       'query'), ctrl.exportReport);

// ── FR-02.2: AI-narrated statements (English + Urdu, grounded in the GL) ─────
router.get('/narrative',           ctrl.getNarrative);

// ── FR-02.5: Custom Report Builder (CRUD + render/preview/schedule) ───────────
const tplCtrl = require('../../controllers/reportTemplate.controller');
const {
  createTemplateSchema, updateTemplateSchema, renderSchema, previewSchema, scheduleSchema,
} = require('../../validations/reportTemplate.validation');

router.get('/templates',              tplCtrl.list);
router.post('/templates',             validate(createTemplateSchema, 'body'), tplCtrl.create);
// NOTE: /templates/preview MUST be declared before /templates/:id so "preview" is not captured as an :id
router.post('/templates/preview',     validate(previewSchema, 'body'),        tplCtrl.preview);
router.get('/templates/:id',          tplCtrl.getOne);
router.put('/templates/:id',          validate(updateTemplateSchema, 'body'), tplCtrl.update);
router.delete('/templates/:id',       tplCtrl.remove);
router.post('/templates/:id/render',  validate(renderSchema, 'body'),         tplCtrl.render);
router.put('/templates/:id/schedule', validate(scheduleSchema, 'body'),       tplCtrl.setSchedule);
// NOTE: GET /templates/:id/export is added in Task 8 (after the PDF helper exists)

module.exports = router;

/**
 * fiscalYear.routes.js — Phase 5.1 Accounting Period Engine
 */
'use strict';

const express    = require('express');
const router     = express.Router();
const ctrl       = require('../../controllers/fiscalYear.controller');
const { authMiddleware }  = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');

router.use(authMiddleware, requireBusiness);

/* ── Fiscal Years ─────────────────────────────────────────────────────────── */
router.get( '/',                             ctrl.listFiscalYears);
router.post('/',                             ctrl.createFiscalYear);
router.post('/:fiscalYearId/close',          ctrl.runClosingEntries);
router.post('/:fiscalYearId/opening-balances', ctrl.createOpeningBalances);
router.post('/:fiscalYearId/lock',           ctrl.lockFiscalYear);

/* ── Accounting Periods ───────────────────────────────────────────────────── */
router.get( '/:fiscalYearId/periods',        ctrl.listPeriods);
router.post('/periods/:periodId/close',      ctrl.closePeriod);
router.post('/periods/:periodId/lock',       ctrl.lockPeriod);
router.post('/periods/:periodId/reopen',     ctrl.reopenPeriod);

/* ── Adjusting Entries ───────────────────────────────────────────────────── */
router.post('/adjusting-entry',              ctrl.createAdjustingEntry);

module.exports = router;

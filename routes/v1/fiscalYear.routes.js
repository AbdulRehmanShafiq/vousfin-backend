/**
 * fiscalYear.routes.js — Phase 5.1 Accounting Period Engine
 */
'use strict';

const express    = require('express');
const router     = express.Router();
const ctrl       = require('../../controllers/fiscalYear.controller');
const { authMiddleware }  = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const { attachMembership, requirePermission } = require('../../middleware/rbac.middleware'); // Phase 6A — RBAC
const { PERMISSIONS } = require('../../config/constants');
const SETTINGS = requirePermission(PERMISSIONS.SETTINGS_MANAGE);

router.use(authMiddleware, requireBusiness, attachMembership);

/* ── Fiscal Years ─────────────────────────────────────────────────────────── */
router.get( '/',                             ctrl.listFiscalYears);
router.get( '/current-period',               ctrl.getCurrentPeriod);
router.post('/',                             SETTINGS, ctrl.createFiscalYear);
router.post('/:fiscalYearId/close',          SETTINGS, ctrl.runClosingEntries);
router.post('/:fiscalYearId/opening-balances', SETTINGS, ctrl.createOpeningBalances);
router.post('/:fiscalYearId/lock',           SETTINGS, ctrl.lockFiscalYear);

/* ── Accounting Periods ───────────────────────────────────────────────────── */
router.get( '/:fiscalYearId/periods',        ctrl.listPeriods);
router.post('/periods/:periodId/close',      SETTINGS, ctrl.closePeriod);
router.post('/periods/:periodId/lock',       SETTINGS, ctrl.lockPeriod);
router.post('/periods/:periodId/reopen',     SETTINGS, ctrl.reopenPeriod);

/* ── Adjusting Entries ───────────────────────────────────────────────────── */
router.post('/adjusting-entry',              SETTINGS, ctrl.createAdjustingEntry);

module.exports = router;

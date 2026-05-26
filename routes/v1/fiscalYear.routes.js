// routes/v1/fiscalYear.routes.js — Phase 5.1 Accounting Period Engine
'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/fiscalYear.controller');
const { authMiddleware }   = require('../../middleware/auth.middleware');
const { requireBusiness }  = require('../../middleware/business.middleware');
const validate = require('../../middleware/validate.middleware');
const Joi      = require('joi');

// ── Validation schemas ────────────────────────────────────────────────────────

const createFySchema = Joi.object({
  name:      Joi.string().min(2).max(50).required(),
  startDate: Joi.date().iso().required(),
  endDate:   Joi.date().iso().greater(Joi.ref('startDate')).required(),
});

const reasonSchema = Joi.object({
  reason: Joi.string().max(500).optional().allow(''),
});

const adjustingEntrySchema = Joi.object({
  adjustingType:   Joi.string().valid('accrual','deferral','year_end','depreciation').required(),
  periodId:        Joi.string().length(24).required(),
  description:     Joi.string().max(500).optional(),
  amount:          Joi.number().positive().required(),
  debitAccountId:  Joi.string().length(24).required(),
  creditAccountId: Joi.string().length(24).required(),
  memo:            Joi.string().max(1000).optional().allow(''),
});

// All fiscal year routes require auth + business context
router.use(authMiddleware, requireBusiness);

// ── Fiscal Year ───────────────────────────────────────────────────────────────
router.get ('/',                      ctrl.listFiscalYears);
router.post('/', validate(createFySchema),        ctrl.createFiscalYear);
router.get ('/:id',                   ctrl.getFiscalYear);
router.post('/:id/close', validate(reasonSchema), ctrl.closeFiscalYear);
router.post('/:id/lock',  validate(reasonSchema), ctrl.lockFiscalYear);

// ── Periods within a fiscal year ─────────────────────────────────────────────
router.get ('/:id/periods',                                      ctrl.getPeriodsForYear);
router.post('/periods/:periodId/close',  validate(reasonSchema), ctrl.closePeriod);
router.post('/periods/:periodId/lock',   validate(reasonSchema), ctrl.lockPeriod);
router.post('/periods/:periodId/reopen', validate(reasonSchema), ctrl.reopenPeriod);

// ── Adjusting entries ─────────────────────────────────────────────────────────
router.post('/adjusting-entries', validate(adjustingEntrySchema), ctrl.postAdjustingEntry);

// ── Current period (used by UI banner) ───────────────────────────────────────
router.get('/current-period', ctrl.getCurrentPeriod);

module.exports = router;

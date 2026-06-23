// routes/v1/fxRate.routes.js
const express        = require('express');
const router         = express.Router();
const fxRateCtrl     = require('../../controllers/fxRate.controller');
const { authMiddleware }  = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate       = require('../../middleware/validate.middleware');
const {
  createFxRateSchema,
  updateFxRateSchema,
  bulkUpsertFxRatesSchema,
  listFxRatesSchema,
  revaluationSchema,
  rateIdParamSchema,
} = require('../../validations/fxRate.validation');
const { attachMembership, writeGuard } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');

// All routes require authentication + an active business
router.use(authMiddleware, requireBusiness, attachMembership, writeGuard(PERMISSIONS.SETTINGS_MANAGE));

// ── Utility (no :id, must come first to avoid route collision) ──────────────
router.get( '/convert',        fxRateCtrl.convertPreview);   // ?from=USD&to=PKR&amount=1000
router.get( '/pairs',          fxRateCtrl.listPairs);        // distinct currency pairs
router.get( '/latest',         fxRateCtrl.latestRates);      // most recent rate per pair
router.post('/bulk',           validate(bulkUpsertFxRatesSchema), fxRateCtrl.bulkUpsertRates);
router.post('/sync',           fxRateCtrl.syncRates);              // live rate fetch from open.er-api.com
router.post('/revaluate',      validate(revaluationSchema),       fxRateCtrl.runRevaluation);

// ── Collection ───────────────────────────────────────────────────────────────
router.get( '/',   validate(listFxRatesSchema, 'query'),  fxRateCtrl.listRates);
router.post('/',   validate(createFxRateSchema),          fxRateCtrl.createRate);

// ── Single record ─────────────────────────────────────────────────────────────
router.get(   '/:id', validate(rateIdParamSchema, 'params'), fxRateCtrl.getRate);
router.put(   '/:id', validate(rateIdParamSchema, 'params'), validate(updateFxRateSchema), fxRateCtrl.updateRate);
router.delete('/:id', validate(rateIdParamSchema, 'params'), fxRateCtrl.deleteRate);

module.exports = router;

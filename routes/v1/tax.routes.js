// routes/v1/tax.routes.js — Phase 5.4.3
const express      = require('express');
const router       = express.Router();
const taxCtrl      = require('../../controllers/tax.controller');
const { authMiddleware }  = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate     = require('../../middleware/validate.middleware');
const {
  updateTaxConfigSchema,
  enableTaxSchema,
  taxPreviewSchema,
  countryCodeParamSchema,
} = require('../../validations/tax.validation');

// All routes require authentication + active business
router.use(authMiddleware, requireBusiness);

// ── Configuration ────────────────────────────────────────────────────────────
router.get('/config',               taxCtrl.getConfig);
router.put('/config',               validate(updateTaxConfigSchema),           taxCtrl.updateConfig);
router.post('/enable',              validate(enableTaxSchema),                  taxCtrl.enableTax);

// ── Tax Accounts ─────────────────────────────────────────────────────────────
router.get('/accounts',             taxCtrl.listTaxAccounts);

// ── Preview (pure calc, no DB write) ─────────────────────────────────────────
router.post('/preview',             validate(taxPreviewSchema),                 taxCtrl.preview);

// ── Country Profiles (informational) ─────────────────────────────────────────
router.get('/profiles',             taxCtrl.listProfiles);
router.get('/profiles/:code',       validate(countryCodeParamSchema, 'params'), taxCtrl.getProfile);

module.exports = router;

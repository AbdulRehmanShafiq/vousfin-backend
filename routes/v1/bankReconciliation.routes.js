// routes/v1/bankReconciliation.routes.js
const express = require('express');
const multer = require('multer');
const router = express.Router();
const controller = require('../../controllers/bankReconciliation.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate = require('../../middleware/validate.middleware');
const {
  importSchema, matchSchema, createFromLineSchema, clearSchema, idParamSchema,
} = require('../../validations/bankReconciliation.validation');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(authMiddleware, requireBusiness);

router.post('/parse', upload.single('file'), controller.parse);
router.post('/import', validate(importSchema), controller.importStatement);
router.get('/', controller.list);
router.get('/:id', validate(idParamSchema, 'params'), controller.getStatement);
router.delete('/:id', validate(idParamSchema, 'params'), controller.remove);
router.post('/:id/finish', validate(idParamSchema, 'params'), controller.finish);
router.post('/:id/auto-match', validate(idParamSchema, 'params'), controller.autoMatch);
router.post('/:id/accept-batch', validate(idParamSchema, 'params'), controller.acceptBatch);

// Per-line actions
router.post('/:id/lines/:lineRef/match',   validate(matchSchema), controller.match);
router.post('/:id/lines/:lineRef/unmatch', controller.unmatch);
router.post('/:id/lines/:lineRef/clear',   validate(clearSchema), controller.clear);
router.post('/:id/lines/:lineRef/create',  validate(createFromLineSchema), controller.createFromLine);

module.exports = router;

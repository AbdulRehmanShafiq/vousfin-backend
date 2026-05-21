const express = require('express');
const multer = require('multer');
const router = express.Router();
const transactionController = require('../../controllers/transaction.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate = require('../../middleware/validate.middleware');
const {
  createTransactionSchema,
  updateTransactionSchema,
  recordPaymentSchema,
  createInstallmentSchema,
  naturalLanguageSchema,
  confirmNaturalLanguageSchema,
  transactionFiltersSchema,
  transactionIdParamSchema,
} = require('../../validations/transaction.validation');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(authMiddleware, requireBusiness);

// Transaction Creation (v2)
router.post('/form', validate(createTransactionSchema), transactionController.createFormTransaction);

// AR/AP & Settlements (v2)
router.get('/outstanding', transactionController.getOutstandingBalances);
router.post('/payment', validate(recordPaymentSchema), transactionController.recordPayment);
router.get('/:id/settlements', validate(transactionIdParamSchema, 'params'), transactionController.getSettlementHistory);

// Installments (v2)
router.post('/installment', validate(createInstallmentSchema), transactionController.createInstallmentTransaction);
router.post('/installment/:planId/pay', transactionController.recordInstallmentPayment);

// Legacy AI/Excel
router.post('/nl', validate(naturalLanguageSchema), transactionController.processNaturalLanguage);
router.post('/nl/confirm', validate(confirmNaturalLanguageSchema), transactionController.confirmNaturalLanguage);
router.post('/excel', upload.single('file'), transactionController.uploadExcelPreview);
router.post('/excel/confirm', transactionController.confirmExcelImport);

// General Querying and CRUD
router.get('/', validate(transactionFiltersSchema, 'query'), transactionController.getTransactions);
router.get('/:id', validate(transactionIdParamSchema, 'params'), transactionController.getTransactionById);
router.put('/:id', validate(transactionIdParamSchema, 'params'), validate(updateTransactionSchema), transactionController.updateTransaction);
router.delete('/:id', validate(transactionIdParamSchema, 'params'), transactionController.deleteTransaction);

module.exports = router;
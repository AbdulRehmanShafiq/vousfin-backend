'use strict';
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../middleware/auth.middleware');
const validate = require('../../middleware/validate.middleware');
const { submitSchema } = require('../../validations/feedback.validation');
const feedbackController = require('../../controllers/feedback.controller');

// Any authenticated user can submit feedback
router.post('/', authMiddleware, validate(submitSchema), feedbackController.submit);

module.exports = router;

'use strict';
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../middleware/auth.middleware');
const validate = require('../../middleware/validate.middleware');
const { createTicketSchema, replySchema } = require('../../validations/support.validation');
const supportController = require('../../controllers/support.controller');

router.use(authMiddleware);

router.post('/tickets',          validate(createTicketSchema), supportController.createTicket);
router.get('/tickets',           supportController.listMyTickets);
router.get('/tickets/:id',       supportController.getMyTicket);
router.post('/tickets/:id/reply', validate(replySchema), supportController.addUserReply);

module.exports = router;

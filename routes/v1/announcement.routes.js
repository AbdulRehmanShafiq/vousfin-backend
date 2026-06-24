'use strict';
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../middleware/auth.middleware');
const announcementController = require('../../controllers/announcement.controller');

// Any authenticated user can read active announcements
router.get('/active', authMiddleware, announcementController.listActive);

module.exports = router;

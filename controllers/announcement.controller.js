'use strict';
const announcementService = require('../services/announcement.service');
const ApiResponse = require('../utils/ApiResponse');

const listActive = async (req, res, next) => {
  try {
    const data = await announcementService.listActive();
    ApiResponse.success(res, data, 'Active announcements retrieved');
  } catch (err) { next(err); }
};

module.exports = { listActive };

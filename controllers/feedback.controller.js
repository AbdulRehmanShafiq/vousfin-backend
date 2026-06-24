'use strict';
const userFeedbackService = require('../services/userFeedback.service');
const ApiResponse = require('../utils/ApiResponse');

const submit = async (req, res, next) => {
  try {
    const doc = await userFeedbackService.submit(req.body, req.user);
    ApiResponse.created(res, doc, 'Feedback submitted — thank you!');
  } catch (err) {
    next(err);
  }
};

module.exports = { submit };

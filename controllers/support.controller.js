'use strict';
const supportService = require('../services/support.service');
const ApiResponse = require('../utils/ApiResponse');

const createTicket = async (req, res, next) => {
  try {
    const ticket = await supportService.createTicket(req.user, req.body);
    ApiResponse.created(res, ticket, 'Support ticket created');
  } catch (err) { next(err); }
};

const listMyTickets = async (req, res, next) => {
  try {
    const tickets = await supportService.listMyTickets(req.user.id);
    ApiResponse.success(res, tickets, 'Tickets retrieved');
  } catch (err) { next(err); }
};

const getMyTicket = async (req, res, next) => {
  try {
    const ticket = await supportService.getTicket(req.params.id, req.user.id);
    ApiResponse.success(res, ticket, 'Ticket retrieved');
  } catch (err) { next(err); }
};

const addUserReply = async (req, res, next) => {
  try {
    const ticket = await supportService.addUserReply(req.params.id, req.user.id, req.body.body);
    ApiResponse.success(res, ticket, 'Reply added');
  } catch (err) { next(err); }
};

module.exports = { createTicket, listMyTickets, getMyTicket, addUserReply };

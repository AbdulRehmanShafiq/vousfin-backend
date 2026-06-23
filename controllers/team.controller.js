// controllers/team.controller.js — Phase 6A
'use strict';
const membershipService = require('../services/membership.service');
const ApiResponse = require('../utils/ApiResponse');

// The current user's own roles + permissions for this business (any member).
exports.me = (req, res) => {
  ApiResponse.success(res, req.membership || { roles: [], permissions: [] }, 'Your access');
};

exports.list = async (req, res, next) => {
  try {
    ApiResponse.success(res, await membershipService.listMembers(req.user.businessId), 'Members retrieved');
  } catch (e) { next(e); }
};

exports.invite = async (req, res, next) => {
  try {
    const m = await membershipService.invite(req.user.businessId, { email: req.body.email, roles: req.body.roles }, req.user);
    ApiResponse.created(res, m, 'Invitation sent');
  } catch (e) { next(e); }
};

exports.accept = async (req, res, next) => {
  try {
    ApiResponse.success(res, await membershipService.acceptInvite(req.body.token, req.user), 'Invitation accepted');
  } catch (e) { next(e); }
};

exports.updateRoles = async (req, res, next) => {
  try {
    ApiResponse.success(res, await membershipService.updateRoles(req.user.businessId, req.params.userId, req.body.roles, req.user), 'Roles updated');
  } catch (e) { next(e); }
};

exports.remove = async (req, res, next) => {
  try {
    ApiResponse.success(res, await membershipService.removeMember(req.user.businessId, req.params.userId, req.user), 'Member removed');
  } catch (e) { next(e); }
};

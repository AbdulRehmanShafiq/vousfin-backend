'use strict';

const repo = require('../repositories/reportTemplate.repository');
const reportBuilder = require('../services/reportBuilder.service');
const ApiResponse = require('../utils/ApiResponse');
const { ApiError } = require('../utils/ApiError');
const { computeNextRun } = require('../jobs/scheduledReport.job');
const mongoose = require('mongoose');

const today = () => new Date().toISOString().split('T')[0];
const yearStart = () => `${new Date().getFullYear()}-01-01`;
const range = (q) => ({
  startDate: new Date(q.startDate || yearStart()),
  endDate: new Date(q.endDate || today()),
  asOfDate: q.asOfDate ? new Date(q.asOfDate) : undefined,
});

const list = async (req, res, next) => {
  try { ApiResponse.success(res, await repo.findOwned(req.user.businessId), 'Reports listed'); }
  catch (e) { next(e); }
};

const create = async (req, res, next) => {
  try {
    const doc = await repo.create({
      ...req.body,
      businessId: new mongoose.Types.ObjectId(String(req.user.businessId)),
      createdBy: req.user.id ? new mongoose.Types.ObjectId(String(req.user.id)) : undefined,
    });
    ApiResponse.created(res, doc, 'Report saved');
  } catch (e) { next(e); }
};

const getOne = async (req, res, next) => {
  try {
    const doc = await repo.findOwnedById(req.user.businessId, req.params.id);
    if (!doc) throw new ApiError(404, 'Report not found');
    ApiResponse.success(res, doc, 'Report loaded');
  } catch (e) { next(e); }
};

const update = async (req, res, next) => {
  try {
    const doc = await repo.findOwnedById(req.user.businessId, req.params.id);
    if (!doc) throw new ApiError(404, 'Report not found');
    Object.assign(doc, req.body);
    await doc.save();
    ApiResponse.success(res, doc, 'Report updated');
  } catch (e) { next(e); }
};

const remove = async (req, res, next) => {
  try {
    const doc = await repo.findOwnedById(req.user.businessId, req.params.id);
    if (!doc) throw new ApiError(404, 'Report not found');
    await doc.deleteOne();
    ApiResponse.success(res, { id: req.params.id }, 'Report deleted');
  } catch (e) { next(e); }
};

const render = async (req, res, next) => {
  try {
    const data = await reportBuilder.renderTemplate(req.user.businessId, req.params.id, range(req.body));
    ApiResponse.success(res, data, 'Report rendered');
  } catch (e) { next(e); }
};

const preview = async (req, res, next) => {
  try {
    const { startDate, endDate, asOfDate, ...layoutPayload } = req.body;
    const data = await reportBuilder.previewLayout(req.user.businessId, layoutPayload, range({ startDate, endDate, asOfDate }));
    ApiResponse.success(res, data, 'Preview rendered');
  } catch (e) { next(e); }
};

const setSchedule = async (req, res, next) => {
  try {
    const doc = await repo.findOwnedById(req.user.businessId, req.params.id);
    if (!doc) throw new ApiError(404, 'Report not found');
    doc.schedule = {
      ...doc.schedule.toObject?.() ?? doc.schedule,
      ...req.body,
      format: 'pdf',
      nextRunAt: req.body.enabled ? computeNextRun(req.body, new Date()) : null,
    };
    await doc.save();
    ApiResponse.success(res, doc, req.body.enabled ? 'Schedule set' : 'Schedule turned off');
  } catch (e) { next(e); }
};

module.exports = { list, create, getOne, update, remove, render, preview, setSchedule };

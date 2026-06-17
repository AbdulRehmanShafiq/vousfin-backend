// controllers/autonomy.controller.js — Autonomy Phase 0
'use strict';
// Register the models that are only accessed via lazy mongoose.model() lookups,
// so those lookups resolve at runtime (nothing else imports them).
require('../models/AutonomyPolicy.model');
require('../models/FeedbackEvent.model');
require('../models/EntityMemory.model');
require('../models/SourceDocument.model');
// Requiring the agents registers their execute/reverse handlers with the action
// router, so approving/reversing their actions works regardless of route order.
require('../services/bookkeeper.service');
const reconciler = require('../services/reconciler.service');
const collector = require('../services/collector.service');
const paymentsAgent = require('../services/paymentsAgent.service');
const closeAgent = require('../services/closeAgent.service');
const policy = require('../services/autonomyPolicy.service');
const actionRouter = require('../services/actionRouter.service');
const commandCenter = require('../services/commandCenter.service');
const autonomyReport = require('../services/autonomyReport.service');
const repo = require('../repositories/proposedAction.repository');

const actor = (req) => req.user._id || req.user.id || null;

class AutonomyController {
  // GET /autonomy/policy — the per-capability autonomy dials
  async getPolicy(req, res, next) {
    try { res.json({ success: true, data: await policy.getPolicy(req.user.businessId) }); }
    catch (err) { next(err); }
  }

  // PUT /autonomy/policy/:capability — set a capability's level/threshold/limit
  async setCapability(req, res, next) {
    try {
      const data = await policy.setCapability(req.user.businessId, req.params.capability, req.body, actor(req));
      res.json({ success: true, data, message: 'Autonomy updated' });
    } catch (err) { next(err); }
  }

  // GET /autonomy/inbox — the one inbox: proposed actions + wrapped insights
  async getInbox(req, res, next) {
    try { res.json({ success: true, data: await commandCenter.getInbox(req.user.businessId) }); }
    catch (err) { next(err); }
  }

  // POST /autonomy/scan — let the agents look for work (reconciliation + collections)
  // and surface it as proposed actions in the inbox.
  async scan(req, res, next) {
    try {
      const businessId = req.user.businessId;
      const who = { id: req.user._id || req.user.id || null };
      const [reconciliation, collections, payments, close] = await Promise.all([
        reconciler.scanBusiness(businessId, who).catch(() => 0),
        collector.scanBusiness(businessId, who).catch(() => 0),
        paymentsAgent.scanBusiness(businessId, who).catch(() => 0),
        closeAgent.scanBusiness(businessId, who).catch(() => 0),
      ]);
      res.json({ success: true, data: { reconciliation, collections, payments, close, total: reconciliation + collections + payments + close }, message: 'Scan complete' });
    } catch (err) { next(err); }
  }

  // GET /autonomy/close/status — the month-end checklist (the plan view)
  async getCloseStatus(req, res, next) {
    try { res.json({ success: true, data: await closeAgent.getCloseStatus(req.user.businessId) }); }
    catch (err) { next(err); }
  }

  // POST /autonomy/payments/hold — exclude (or re-include) a vendor from payment runs
  async setPaymentHold(req, res, next) {
    try {
      const { vendorId, hold } = req.body;
      if (!vendorId) return res.status(400).json({ success: false, message: 'vendorId is required' });
      const data = await paymentsAgent.setVendorHold(req.user.businessId, vendorId, hold);
      res.json({ success: true, data, message: data.hold ? 'Vendor put on hold' : 'Vendor hold removed' });
    } catch (err) { next(err); }
  }

  // GET /autonomy/report — the Autonomy Report: accuracy + dial recommendations
  async getReport(req, res, next) {
    try { res.json({ success: true, data: await autonomyReport.getReport(req.user.businessId) }); }
    catch (err) { next(err); }
  }

  // GET /autonomy/actions — recent actions in any state (activity view)
  async getActions(req, res, next) {
    try { res.json({ success: true, data: await repo.recent(req.user.businessId) }); }
    catch (err) { next(err); }
  }

  // POST /autonomy/actions/:id/approve
  async approve(req, res, next) {
    try {
      const data = await actionRouter.approve(req.user.businessId, req.params.id, actor(req));
      res.json({ success: true, data, message: 'Action approved' });
    } catch (err) { next(err); }
  }

  // POST /autonomy/actions/:id/reject
  async reject(req, res, next) {
    try {
      const data = await actionRouter.reject(req.user.businessId, req.params.id, actor(req));
      res.json({ success: true, data, message: 'Action dismissed' });
    } catch (err) { next(err); }
  }

  // POST /autonomy/actions/:id/reverse — undo an executed action (one-click)
  async reverse(req, res, next) {
    try {
      const data = await actionRouter.reverse(req.user.businessId, req.params.id, actor(req));
      res.json({ success: true, data, message: 'Action reversed' });
    } catch (err) { next(err); }
  }
}

module.exports = new AutonomyController();

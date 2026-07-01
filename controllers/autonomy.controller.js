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
const stpScorecard = require('../services/stpScorecard.service');
const closeReadiness = require('../services/closeReadiness.service');
const orchestrator = require('../services/orchestrator.service');
const nlControl = require('../services/nlControl.service');
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

  // GET /autonomy/stp-scorecard — Phase 3: automation-depth rates (?days=90)
  async getStpScorecard(req, res, next) {
    try {
      const days = Math.min(365, Math.max(7, Number(req.query.days) || 90));
      res.json({ success: true, data: await stpScorecard.getScorecard(req.user.businessId, { days }) });
    } catch (err) { next(err); }
  }

  // GET /autonomy/close/readiness — Phase 3: weighted close-readiness checklist
  async getCloseReadiness(req, res, next) {
    try { res.json({ success: true, data: await closeReadiness.getReadiness(req.user.businessId) }); }
    catch (err) { next(err); }
  }

  // GET /autonomy/plans — the routines on offer + the latest plan run
  async getPlans(req, res, next) {
    try {
      const [playbooks, latest] = await Promise.all([
        orchestrator.listPlaybooks(),
        orchestrator.getLatestPlan(req.user.businessId),
      ]);
      res.json({ success: true, data: { playbooks, latest } });
    } catch (err) { next(err); }
  }

  // POST /autonomy/plans/:key/run — run a routine; returns the observable plan
  async runPlan(req, res, next) {
    try {
      const who = { id: req.user._id || req.user.id || null };
      const data = await orchestrator.runPlaybook(req.user.businessId, req.params.key, who);
      res.json({ success: true, data, message: 'Routine run' });
    } catch (err) { next(err); }
  }

  // POST /autonomy/control — the plain-language control line ("set tax to autopilot")
  async control(req, res, next) {
    try {
      const data = await nlControl.interpret(req.user.businessId, req.body.text, { id: req.user._id || req.user.id || null });
      res.json({ success: true, data, message: data.message });
    } catch (err) { next(err); }
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

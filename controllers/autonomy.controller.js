// controllers/autonomy.controller.js — Autonomy Phase 0
'use strict';
// Register the model so the policy service's mongoose.model('AutonomyPolicy')
// lookup resolves at runtime (nothing else imports this model).
require('../models/AutonomyPolicy.model');
const policy = require('../services/autonomyPolicy.service');
const actionRouter = require('../services/actionRouter.service');
const commandCenter = require('../services/commandCenter.service');
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
}

module.exports = new AutonomyController();

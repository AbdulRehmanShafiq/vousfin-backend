// services/orchestrator.service.js
//
// Autonomy roadmap Phase 6 — the Orchestrator / Planner.
//
// The agents are useful on their own, but real finance work runs as routines:
// the weekly cash cycle (reconcile → chase → pay) and the monthly close (tidy
// the books → close). The Orchestrator sequences the agents into these named
// playbooks and records each run as one observable plan the owner can read:
// which steps ran, what each surfaced into the inbox, and when.
//
// It doesn't bypass anything — each step just runs that agent's normal scan, so
// everything it surfaces still flows through the autonomy dial (queued for
// approval, or auto-acted within policy). The plan is the lens; the inbox is
// still the single place the owner acts.
//
'use strict';
const { ApiError } = require('../utils/ApiError');
const reconciler = require('./reconciler.service');
const collector = require('./collector.service');
const paymentsAgent = require('./paymentsAgent.service');
const closeAgent = require('./closeAgent.service');
const PlanRun = require('../models/PlanRun.model');
const logger = require('../config/logger');

// Each capability → the agent scan that surfaces its work.
const RUNNERS = {
  reconciliation: (businessId, actor) => reconciler.scanBusiness(businessId, actor),
  collections:    (businessId, actor) => collector.scanBusiness(businessId, actor),
  payments:       (businessId, actor) => paymentsAgent.scanBusiness(businessId, actor),
  close:          (businessId, actor) => closeAgent.scanBusiness(businessId, actor),
};

// The routines, as ordered steps. Order encodes the dependency: reconcile before
// you chase or pay; tidy everything before you close.
const PLAYBOOKS = {
  weekly_cash: {
    name: 'Weekly cash cycle',
    description: 'Reconcile the bank, chase overdue customers, then line up the bills worth paying.',
    steps: [
      { capability: 'reconciliation', label: 'Reconcile the bank' },
      { capability: 'collections',    label: 'Chase overdue customers' },
      { capability: 'payments',       label: 'Line up bill payments' },
    ],
  },
  monthly_close: {
    name: 'Month-end close',
    description: 'Tidy the books — reconcile, chase, pay — then close the month with a plain-language summary.',
    steps: [
      { capability: 'reconciliation', label: 'Reconcile the bank' },
      { capability: 'collections',    label: 'Chase overdue customers' },
      { capability: 'payments',       label: 'Line up bill payments' },
      { capability: 'close',          label: 'Close the month' },
    ],
  },
};

/** The routines on offer (for the plan view). */
function listPlaybooks() {
  return Object.entries(PLAYBOOKS).map(([key, pb]) => ({
    key, name: pb.name, description: pb.description,
    steps: pb.steps.map(s => ({ capability: s.capability, label: s.label })),
  }));
}

/** Run a playbook end-to-end, recording one observable plan. */
async function runPlaybook(businessId, key, actor) {
  const pb = PLAYBOOKS[key];
  if (!pb) throw new ApiError(404, 'Unknown routine');

  const run = await PlanRun.create({
    businessId, playbook: key, name: pb.name, status: 'running', startedBy: actor?.id || null,
    steps: pb.steps.map(s => ({ capability: s.capability, label: s.label, status: 'pending', proposed: 0 })),
  });

  let total = 0;
  for (let i = 0; i < pb.steps.length; i++) {
    const runner = RUNNERS[pb.steps[i].capability];
    try {
      const proposed = runner ? await runner(businessId, actor) : 0;
      run.steps[i].proposed = proposed;
      run.steps[i].status = 'done';
      run.steps[i].ranAt = new Date();
      total += proposed;
    } catch (e) {
      run.steps[i].status = 'failed';
      run.steps[i].error = e.message;
      logger.warn(`[orchestrator] ${key} step ${pb.steps[i].capability} failed: ${e.message}`);
    }
  }

  run.status = 'completed';
  run.totalProposed = total;
  run.finishedAt = new Date();
  await run.save();
  return run.toObject();
}

/** The latest recorded plan run for a business (the plan view). */
async function getLatestPlan(businessId) {
  return PlanRun.findOne({ businessId }).sort({ startedAt: -1 }).lean();
}

module.exports = { listPlaybooks, runPlaybook, getLatestPlan, PLAYBOOKS };

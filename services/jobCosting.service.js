// services/jobCosting.service.js — FR-07.2
'use strict';
const { ApiError } = require('../utils/ApiError');
const { JOB_STATUS } = require('../config/constants');
const repo = require('../repositories/job.repository');
const accountRepo = require('../repositories/account.repository');
const ledger = require('../services/ledgerPosting.service');

const WIP_CODE = '1169';            // Work in Progress (Asset)
const FINISHED_GOODS_CODE = '1150'; // Inventory, used as Finished Goods
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function computeActuals(job) {
  const a = { material: 0, labour: 0, overhead: 0 };
  for (const row of job.costSheet || []) a[row.category] = r2((a[row.category] || 0) + row.amount);
  a.total = r2(a.material + a.labour + a.overhead);
  return a;
}

function computeVariance(job) {
  const actual = computeActuals(job);
  const std = job.standardCost || {};
  const line = (cat) => {
    const s = Number(std[cat]) || 0; const ac = actual[cat] || 0;
    return { standard: s, actual: ac, variance: r2(ac - s), favourable: ac <= s };
  };
  const stdTotal = r2((std.material || 0) + (std.labour || 0) + (std.overhead || 0));
  return {
    material: line('material'), labour: line('labour'), overhead: line('overhead'),
    total: { standard: stdTotal, actual: actual.total, variance: r2(actual.total - stdTotal), favourable: actual.total <= stdTotal },
  };
}

async function createJob(businessId, payload, user) {
  if (await repo.findByCode(businessId, payload.code)) {
    throw new ApiError(409, `A job with code "${payload.code}" already exists.`);
  }
  return repo.create({
    businessId, code: payload.code, name: payload.name,
    customerId: payload.customerId || null,
    status: JOB_STATUS.OPEN,
    standardCost: {
      material: Number(payload.standardCost?.material) || 0,
      labour:   Number(payload.standardCost?.labour) || 0,
      overhead: Number(payload.standardCost?.overhead) || 0,
    },
    createdBy: user.id,
  });
}

async function addCost(businessId, jobId, { category, amount, sourceAccountId, description }, user) {
  const job = await repo.findOwnedById(businessId, jobId);
  if (!job) throw new ApiError(404, 'Job not found.');
  if (job.status !== JOB_STATUS.OPEN && job.status !== JOB_STATUS.IN_PROGRESS) {
    throw new ApiError(409, 'Costs can only be added while a job is open or in progress.');
  }
  const wip = await accountRepo.findByCode(businessId, WIP_CODE);
  if (!wip) throw new ApiError(400, 'Work in Progress account (1169) is missing.');
  const source = await accountRepo.findOneByBusinessAndId(businessId, sourceAccountId);
  if (!source) throw new ApiError(400, 'Source account not found for this business.');

  const je = await ledger.postBalancedJournal({
    businessId, transactionDate: new Date(),
    description: description || `Job ${job.code}: ${category} cost`,
    amount: r2(amount), debitAccountId: wip._id, creditAccountId: source._id,
    inputMethod: 'form', createdBy: user.id, entryType: 'normal',
    transactionSource: 'manual', tags: ['job-cost', `job-${job.code}`, category],
    metadata: { jobId: String(job._id), jobCostCategory: category },
  });

  job.costSheet.push({ date: new Date(), category, description: description || '', amount: r2(amount), sourceAccountId: source._id, journalEntryId: je._id });
  job.wipJournalEntryIds.push(je._id);
  if (job.status === JOB_STATUS.OPEN) job.status = JOB_STATUS.IN_PROGRESS;
  await job.save();
  return job;
}

async function completeJob(businessId, jobId, user) {
  const job = await repo.findOwnedById(businessId, jobId);
  if (!job) throw new ApiError(404, 'Job not found.');
  if (job.status !== JOB_STATUS.IN_PROGRESS) throw new ApiError(409, 'Only a job in progress can be completed.');
  const actuals = computeActuals(job);
  if (actuals.total <= 0) throw new ApiError(409, 'This job has no cost to transfer.');
  const fg = await accountRepo.findByCode(businessId, FINISHED_GOODS_CODE);
  const wip = await accountRepo.findByCode(businessId, WIP_CODE);
  if (!fg || !wip) throw new ApiError(400, 'Inventory (1150) or Work in Progress (1169) account is missing.');
  const je = await ledger.postBalancedJournal({
    businessId, transactionDate: new Date(),
    description: `Job ${job.code} completed — cost to finished goods`,
    amount: actuals.total, debitAccountId: fg._id, creditAccountId: wip._id,
    inputMethod: 'form', createdBy: user.id, entryType: 'normal',
    transactionSource: 'manual', tags: ['job-complete', `job-${job.code}`],
    metadata: { jobId: String(job._id) },
  });
  job.status = JOB_STATUS.COMPLETED;
  job.completionJournalEntryId = je._id;
  job.completedAt = new Date();
  await job.save();
  return job;
}

async function cancelJob(businessId, jobId, user) {
  const job = await repo.findOwnedById(businessId, jobId);
  if (!job) throw new ApiError(404, 'Job not found.');
  if (job.status === JOB_STATUS.COMPLETED || job.status === JOB_STATUS.CANCELLED) {
    throw new ApiError(409, 'A completed or cancelled job cannot be cancelled.');
  }
  const transactionService = require('./transaction.service');
  const reversalIds = [];
  for (const jeId of job.wipJournalEntryIds || []) {
    try {
      const rev = await transactionService.reverseTransaction(jeId, businessId, { reason: `Job ${job.code} cancelled` }, user.id, '0.0.0.0');
      if (rev && rev._id) reversalIds.push(rev._id);
    } catch (e) { /* best-effort: a reversal failure must not strand the cancel */ }
  }
  job.status = JOB_STATUS.CANCELLED;
  await job.save();
  return { job, reversalIds };
}

async function listJobs(businessId, filters) { return repo.findOwned(businessId, filters); }
async function getJob(businessId, id) {
  const job = await repo.findOwnedById(businessId, id);
  if (!job) throw new ApiError(404, 'Job not found.');
  const obj = job.toObject ? job.toObject() : job;
  return { ...obj, actualCost: computeActuals(obj), variance: computeVariance(obj) };
}

module.exports = { createJob, addCost, completeJob, cancelJob, computeActuals, computeVariance, listJobs, getJob };

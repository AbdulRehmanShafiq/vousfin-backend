# Cost Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build GL-native job costing (FR-07.2), profitability by dimension (FR-07.3), and break-even/what-if (FR-07.4).

**Architecture:** A `Job` model + `jobCosting.service` that posts costs into WIP (1169) and transfers finished cost to Inventory/FG (1150) via `postBalancedJournal`; a `profitability.service` that reads the canonical `EFFECTIVE_LINES_STAGE` and groups by `customerId` / `inventoryItemId` / `costCenterId`; a stateless `breakEven.service`. One `/cost` route namespace + three React pages.

**Tech Stack:** Node/Express/Mongoose 9, Jest (mocked models — never `{ virtual:true }`; tests in `tests/unit/...` and `tests/integration/...`), React 19/Vite/TanStack Query.

**Spec:** `docs/superpowers/specs/2026-06-19-cost-accounting-design.md`

**Key facts (verified):** account.repository has `findByCode(businessId, code)` & `findOneByBusinessAndId`; `ApiResponse.success(res, data, msg, status)` / `.created(res, data, msg)`; `ACCOUNT_SUBTYPES.DIRECT_COST === 'Direct Cost'`; WIP=`1169`, Inventory(FG)=`1150`; `transaction.repository` exports `EFFECTIVE_LINES_STAGE` + `REPORT_STATUSES`; `postBalancedJournal(entry)` requires caller to set `inputMethod` + `createdBy`.

---

## File Structure
**Create (backend):** `models/Job.model.js`, `repositories/job.repository.js`, `services/jobCosting.service.js`, `services/profitability.service.js`, `services/breakEven.service.js`, `validations/cost.validation.js`, `controllers/cost.controller.js`, `routes/v1/cost.routes.js` + tests under `tests/unit/{models,repositories,services,controllers}/` and `tests/integration/`.
**Modify (backend):** `config/constants.js`, `routes/index.js`.
**Create (frontend):** `src/services/cost.service.js`, `src/pages/cost/{JobCostingPage,ProfitabilityPage,BreakEvenPage}.jsx`.
**Modify (frontend):** `src/components/layout/nav.config.js`, `src/routes.jsx`.

---

## Task 1: Cost constants

**Files:** Modify `config/constants.js`

- [ ] **Step 1: Add after the BUDGET constants block** (inside `module.exports`):

```js
  // Job costing (SRS FR-07.2)
  JOB_STATUS: {
    OPEN: 'open', IN_PROGRESS: 'in_progress', COMPLETED: 'completed', CANCELLED: 'cancelled',
  },
  JOB_STATUS_TRANSITIONS: {
    open:        ['in_progress', 'cancelled'],
    in_progress: ['completed', 'cancelled'],
    completed:   [],
    cancelled:   [],
  },
  JOB_COST_CATEGORIES: ['material', 'labour', 'overhead'],
```

- [ ] **Step 2: Verify.**
Run: `node -e "const c=require('./config/constants'); console.log(c.JOB_STATUS.OPEN, c.JOB_COST_CATEGORIES.join(','), JSON.stringify(c.JOB_STATUS_TRANSITIONS.open))"`
Expected: `open material,labour,overhead ["in_progress","cancelled"]`

- [ ] **Step 3: Commit.**
```bash
git add config/constants.js && git commit -m "feat(cost): job status + cost-category constants"
```

---

## Task 2: Job model

**Files:** Create `models/Job.model.js`; Test `tests/unit/models/job.model.test.js`

- [ ] **Step 1: Write the failing test.**
```js
// tests/unit/models/job.model.test.js
'use strict';
const Job = require('../../../models/Job.model');
describe('Job model', () => {
  test('canTransition follows JOB_STATUS_TRANSITIONS', () => {
    expect(Job.canTransition('open', 'in_progress')).toBe(true);
    expect(Job.canTransition('in_progress', 'completed')).toBe(true);
    expect(Job.canTransition('completed', 'open')).toBe(false);
    expect(Job.canTransition('cancelled', 'in_progress')).toBe(false);
  });
  test('defaults: status=open, zeroed standardCost, empty costSheet', () => {
    const j = new Job({ businessId: '64b000000000000000000001', code: 'J1', name: 'X',
      createdBy: '64b000000000000000000002' });
    expect(j.status).toBe('open');
    expect(j.standardCost.material).toBe(0);
    expect(j.costSheet).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run → FAIL** (`Cannot find module`).
Run: `npx jest tests/unit/models/job.model.test.js`

- [ ] **Step 3: Implement.**
```js
// models/Job.model.js — FR-07.2
'use strict';
const mongoose = require('mongoose');
const { JOB_STATUS, JOB_STATUS_TRANSITIONS, JOB_COST_CATEGORIES } = require('../config/constants');

const costRowSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  category: { type: String, enum: JOB_COST_CATEGORIES, required: true },
  description: { type: String, default: '' },
  amount: { type: Number, required: true, min: 0.01 },
  sourceAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', required: true },
  journalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
}, { _id: false });

const jobSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  code: { type: String, required: true, trim: true, maxlength: 40 },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
  status: { type: String, enum: Object.values(JOB_STATUS), default: JOB_STATUS.OPEN },
  standardCost: {
    material: { type: Number, default: 0 },
    labour:   { type: Number, default: 0 },
    overhead: { type: Number, default: 0 },
  },
  costSheet: { type: [costRowSchema], default: [] },
  wipJournalEntryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry' }],
  completionJournalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
  completedAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } });

jobSchema.index({ businessId: 1, code: 1 }, { unique: true });
jobSchema.statics.canTransition = (from, to) => (JOB_STATUS_TRANSITIONS[from] || []).includes(to);

module.exports = mongoose.model('Job', jobSchema);
```

- [ ] **Step 4: Run → PASS.** `npx jest tests/unit/models/job.model.test.js`
- [ ] **Step 5: Commit.**
```bash
git add models/Job.model.js tests/unit/models/job.model.test.js
git commit -m "feat(cost): Job model with cost sheet + status machine"
```

---

## Task 3: Job repository

**Files:** Create `repositories/job.repository.js`; Test `tests/unit/repositories/job.repository.test.js`

- [ ] **Step 1: Write the failing test.**
```js
// tests/unit/repositories/job.repository.test.js
'use strict';
jest.mock('../../../models/Job.model', () => {
  const m = function () {}; m.find = jest.fn(); m.findOne = jest.fn(); return m;
});
const Job = require('../../../models/Job.model');
const repo = require('../../../repositories/job.repository');
describe('job.repository', () => {
  beforeEach(() => jest.clearAllMocks());
  test('findByCode queries businessId+code', async () => {
    Job.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'j1' }) });
    const r = await repo.findByCode('biz1', 'J1');
    expect(Job.findOne).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'biz1', code: 'J1' }));
    expect(r._id).toBe('j1');
  });
  test('findOwned applies status filter and sorts by createdAt desc', async () => {
    const sort = jest.fn(() => ({ lean: () => Promise.resolve([]) }));
    Job.find.mockReturnValue({ sort });
    await repo.findOwned('biz1', { status: 'open' });
    expect(Job.find).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'biz1', status: 'open' }));
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
```js
// repositories/job.repository.js — FR-07.2
'use strict';
const BaseRepository = require('./base.repository');
const Job = require('../models/Job.model');
class JobRepository extends BaseRepository {
  constructor() { super(Job); }
  findByCode(businessId, code) { return this.model.findOne({ businessId, code }).lean(); }
  findOwned(businessId, filters = {}) {
    const q = { businessId };
    if (filters.status) q.status = filters.status;
    if (filters.customerId) q.customerId = filters.customerId;
    return this.model.find(q).sort({ createdAt: -1 }).lean();
  }
  findOwnedById(businessId, id) { return this.model.findOne({ _id: id, businessId }); } // live doc
}
module.exports = new JobRepository();
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.**
```bash
git add repositories/job.repository.js tests/unit/repositories/job.repository.test.js
git commit -m "feat(cost): job repository"
```

---

## Task 4: jobCosting.service — createJob + addCost + helpers

**Files:** Create `services/jobCosting.service.js`; Test `tests/unit/services/jobCosting.service.test.js`

- [ ] **Step 1: Write the failing test.**
```js
// tests/unit/services/jobCosting.service.test.js
'use strict';
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../repositories/job.repository');
jest.mock('../../../repositories/account.repository', () => ({ findByCode: jest.fn(), findOneByBusinessAndId: jest.fn() }));
jest.mock('../../../services/ledgerPosting.service', () => ({ postBalancedJournal: jest.fn() }));

const repo = require('../../../repositories/job.repository');
const accountRepo = require('../../../repositories/account.repository');
const ledger = require('../../../services/ledgerPosting.service');
const svc = require('../../../services/jobCosting.service');

describe('jobCosting.service — createJob', () => {
  beforeEach(() => jest.clearAllMocks());
  test('creates an open job, dup code → 409', async () => {
    repo.findByCode.mockResolvedValue(null);
    repo.create.mockResolvedValue({ _id: 'j1', status: 'open' });
    const out = await svc.createJob('biz1', { code: 'J1', name: 'Roof', standardCost: { material: 100 } }, { id: 'u1' });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'biz1', code: 'J1', createdBy: 'u1' }));
    expect(out._id).toBe('j1');
    repo.findByCode.mockResolvedValue({ _id: 'dup' });
    await expect(svc.createJob('biz1', { code: 'J1', name: 'x' }, { id: 'u1' })).rejects.toThrow(/already exists/i);
  });
});

describe('jobCosting.service — addCost', () => {
  beforeEach(() => jest.clearAllMocks());
  test('posts Dr WIP / Cr source, appends cost sheet, flips open→in_progress', async () => {
    const job = { _id: 'j1', businessId: 'biz1', status: 'open', costSheet: [], wipJournalEntryIds: [],
      save: jest.fn().mockResolvedValue(true) };
    repo.findOwnedById.mockResolvedValue(job);
    accountRepo.findByCode.mockResolvedValue({ _id: 'wip169' });          // WIP 1169
    accountRepo.findOneByBusinessAndId.mockResolvedValue({ _id: 'cash' }); // source account
    ledger.postBalancedJournal.mockResolvedValue({ _id: 'je1' });
    const out = await svc.addCost('biz1', 'j1', { category: 'material', amount: 500, sourceAccountId: 'cash', description: 'wood' }, { id: 'u1' });
    expect(ledger.postBalancedJournal).toHaveBeenCalledWith(expect.objectContaining({
      debitAccountId: 'wip169', creditAccountId: 'cash', amount: 500, inputMethod: 'form', createdBy: 'u1' }));
    expect(job.costSheet).toHaveLength(1);
    expect(job.costSheet[0]).toMatchObject({ category: 'material', amount: 500, journalEntryId: 'je1' });
    expect(job.status).toBe('in_progress');
    expect(out).toBe(job);
  });
  test('rejects adding cost to a completed job', async () => {
    repo.findOwnedById.mockResolvedValue({ _id: 'j1', status: 'completed' });
    await expect(svc.addCost('biz1', 'j1', { category: 'labour', amount: 1, sourceAccountId: 'x' }, { id: 'u1' }))
      .rejects.toThrow(/open|progress/i);
  });
});

describe('jobCosting.service — computeActuals/variance', () => {
  test('actuals sum by category; variance = actual − standard', () => {
    const job = { standardCost: { material: 400, labour: 200, overhead: 100 },
      costSheet: [
        { category: 'material', amount: 300 }, { category: 'material', amount: 150 },
        { category: 'labour', amount: 200 }, { category: 'overhead', amount: 120 },
      ] };
    const a = svc.computeActuals(job);
    expect(a).toMatchObject({ material: 450, labour: 200, overhead: 120, total: 770 });
    const v = svc.computeVariance(job);
    expect(v.material).toMatchObject({ standard: 400, actual: 450, variance: 50, favourable: false });
    expect(v.labour).toMatchObject({ variance: 0, favourable: true });
    expect(v.overhead).toMatchObject({ variance: 20, favourable: false });
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement (grows in Task 5).**
```js
// services/jobCosting.service.js — FR-07.2
'use strict';
const { ApiError } = require('../utils/ApiError');
const { JOB_STATUS } = require('../config/constants');
const repo = require('../repositories/job.repository');
const accountRepo = require('../repositories/account.repository');
const ledger = require('../services/ledgerPosting.service');

const WIP_CODE = '1169';        // Work in Progress (Asset)
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

async function listJobs(businessId, filters) { return repo.findOwned(businessId, filters); }
async function getJob(businessId, id) {
  const job = await repo.findOwnedById(businessId, id);
  if (!job) throw new ApiError(404, 'Job not found.');
  const obj = job.toObject ? job.toObject() : job;
  return { ...obj, actualCost: computeActuals(obj), variance: computeVariance(obj) };
}

module.exports = { createJob, addCost, computeActuals, computeVariance, listJobs, getJob };
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.**
```bash
git add services/jobCosting.service.js tests/unit/services/jobCosting.service.test.js
git commit -m "feat(cost): jobCosting createJob/addCost + actual/variance"
```

---

## Task 5: jobCosting.service — completeJob + cancelJob

**Files:** Modify `services/jobCosting.service.js`; Modify the test file.

- [ ] **Step 1: Add failing tests.**
```js
describe('jobCosting.service — completeJob/cancelJob', () => {
  beforeEach(() => jest.clearAllMocks());
  test('completeJob posts Dr FG / Cr WIP for total actual cost and marks completed', async () => {
    const job = { _id: 'j1', businessId: 'biz1', code: 'J1', status: 'in_progress',
      costSheet: [{ category: 'material', amount: 300 }, { category: 'labour', amount: 200 }],
      wipJournalEntryIds: ['je1'], save: jest.fn().mockResolvedValue(true) };
    repo.findOwnedById.mockResolvedValue(job);
    accountRepo.findByCode.mockImplementation((b, code) => Promise.resolve({ _id: code === '1150' ? 'fg150' : 'wip169' }));
    ledger.postBalancedJournal.mockResolvedValue({ _id: 'jeC' });
    const out = await svc.completeJob('biz1', 'j1', { id: 'u1' });
    expect(ledger.postBalancedJournal).toHaveBeenCalledWith(expect.objectContaining({
      debitAccountId: 'fg150', creditAccountId: 'wip169', amount: 500, createdBy: 'u1' }));
    expect(out.status).toBe('completed');
    expect(out.completionJournalEntryId).toBe('jeC');
  });
  test('completeJob rejects when not in progress', async () => {
    repo.findOwnedById.mockResolvedValue({ _id: 'j1', status: 'open', costSheet: [] });
    await expect(svc.completeJob('biz1', 'j1', { id: 'u1' })).rejects.toThrow(/progress/i);
  });
  test('completeJob rejects with zero cost', async () => {
    repo.findOwnedById.mockResolvedValue({ _id: 'j1', status: 'in_progress', costSheet: [] });
    await expect(svc.completeJob('biz1', 'j1', { id: 'u1' })).rejects.toThrow(/no cost/i);
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — add to `jobCosting.service.js` and export:
```js
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
  // Reverse each WIP posting so WIP nets to zero, then mark cancelled.
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
```
Add `completeJob, cancelJob` to `module.exports`.

- [ ] **Step 4: Run → PASS** (`npx jest tests/unit/services/jobCosting.service.test.js`).
- [ ] **Step 5: Commit.**
```bash
git add services/jobCosting.service.js tests/unit/services/jobCosting.service.test.js
git commit -m "feat(cost): completeJob (WIP→FG) + cancelJob (reverse WIP)"
```

---

## Task 6: profitability.service

**Files:** Create `services/profitability.service.js`; Test `tests/unit/services/profitability.service.test.js`

- [ ] **Step 1: Write the failing test.**
```js
// tests/unit/services/profitability.service.test.js
'use strict';
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockAggregate = jest.fn();
jest.mock('../../../models/JournalEntry.model', () => ({ aggregate: (...a) => mockAggregate(...a) }));
jest.mock('../../../repositories/transaction.repository', () => ({
  EFFECTIVE_LINES_STAGE: { $addFields: { effectiveLines: '$x' } },
  REPORT_STATUSES: ['posted', 'partially_settled', 'settled'],
}));
jest.mock('../../../models/Customer.model', () => ({ find: jest.fn(() => ({ lean: () => Promise.resolve([{ _id: 'c1', name: 'Acme' }]) })) }));
jest.mock('../../../models/InventoryItem.model', () => ({ find: jest.fn(() => ({ lean: () => Promise.resolve([]) })) }));
jest.mock('../../../repositories/costCenter.repository', () => ({ findByBusiness: jest.fn(() => Promise.resolve([])) }));

const profitability = require('../../../services/profitability.service');

describe('profitability.byDimension', () => {
  beforeEach(() => jest.clearAllMocks());
  test('computes revenue, variable cost, gross margin, GM%, loss-maker flag', async () => {
    mockAggregate.mockResolvedValue([
      { _id: 'c1', revenue: 540000, variableCost: 360000 },
      { _id: 'c2', revenue: 100000, variableCost: 130000 },
    ]);
    const out = await profitability.byDimension('biz1', 'customer', { from: '2026-01-01', to: '2026-12-31' });
    const a = out.segments.find((s) => s.id === 'c1');
    const b = out.segments.find((s) => s.id === 'c2');
    expect(a).toMatchObject({ revenue: 540000, variableCost: 360000, grossMargin: 180000, lossMaker: false });
    expect(Math.round(a.grossMarginPct * 1000) / 1000).toBe(0.333);
    expect(b).toMatchObject({ grossMargin: -30000, lossMaker: true });
    expect(out.totals.grossMargin).toBe(150000);
  });
  test('rejects an unknown dimension', async () => {
    await expect(profitability.byDimension('biz1', 'galaxy', {})).rejects.toThrow(/dimension/i);
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
```js
// services/profitability.service.js — FR-07.3
'use strict';
const mongoose = require('mongoose');
const JournalEntry = require('../models/JournalEntry.model');
const { EFFECTIVE_LINES_STAGE, REPORT_STATUSES } = require('../repositories/transaction.repository');
const { ApiError } = require('../utils/ApiError');

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const DIM_FIELD = {
  customer: '$customerId',
  product: '$inventoryItemId',
  cost_center: { $ifNull: ['$effectiveLines.costCenterId', '$costCenterId'] },
};

async function _names(businessId, dim, ids) {
  const real = ids.filter(Boolean).map((i) => oid(i));
  if (real.length === 0) return new Map();
  if (dim === 'customer') {
    const Customer = require('../models/Customer.model');
    const rows = await Customer.find({ businessId, _id: { $in: real } }).lean();
    return new Map(rows.map((r) => [String(r._id), r.name]));
  }
  if (dim === 'product') {
    const InventoryItem = require('../models/InventoryItem.model');
    const rows = await InventoryItem.find({ businessId, _id: { $in: real } }).lean();
    return new Map(rows.map((r) => [String(r._id), r.name]));
  }
  const ccRepo = require('../repositories/costCenter.repository');
  const rows = await ccRepo.findByBusiness(businessId);
  return new Map((rows || []).map((r) => [String(r._id), r.name]));
}

async function byDimension(businessId, dim, { from, to }) {
  if (!DIM_FIELD[dim]) throw new ApiError(400, `Unknown profitability dimension "${dim}".`);
  const match = {
    businessId: oid(businessId),
    status: { $in: REPORT_STATUSES },
    isArchived: { $ne: true },
  };
  if (from || to) {
    match.transactionDate = {};
    if (from) match.transactionDate.$gte = new Date(from);
    if (to) match.transactionDate.$lte = new Date(to);
  }
  const rows = await JournalEntry.aggregate([
    { $match: match },
    EFFECTIVE_LINES_STAGE,
    { $unwind: '$effectiveLines' },
    { $lookup: { from: 'chartofaccounts', localField: 'effectiveLines.accountId', foreignField: '_id',
      as: 'acc', pipeline: [{ $project: { accountType: 1, accountSubtype: 1 } }] } },
    { $unwind: { path: '$acc', preserveNullAndEmptyArrays: true } },
    { $group: {
      _id: DIM_FIELD[dim],
      revenue: { $sum: { $cond: [{ $and: [{ $eq: ['$acc.accountType', 'Revenue'] }, { $eq: ['$effectiveLines.type', 'credit'] }] }, '$effectiveLines.amount', 0] } },
      variableCost: { $sum: { $cond: [{ $and: [{ $eq: ['$acc.accountSubtype', 'Direct Cost'] }, { $eq: ['$effectiveLines.type', 'debit'] }] }, '$effectiveLines.amount', 0] } },
    } },
  ]);

  const names = await _names(businessId, dim, rows.map((r) => r._id && String(r._id)));
  const segments = rows
    .filter((r) => r.revenue !== 0 || r.variableCost !== 0)
    .map((r) => {
      const revenue = r2(r.revenue); const variableCost = r2(r.variableCost);
      const grossMargin = r2(revenue - variableCost);
      return {
        id: r._id ? String(r._id) : null,
        name: r._id ? (names.get(String(r._id)) || 'Unknown') : 'Unassigned',
        revenue, variableCost, grossMargin,
        grossMarginPct: revenue ? r2(grossMargin / revenue) : null,
        contributionMargin: grossMargin,
        lossMaker: grossMargin < 0,
      };
    })
    .sort((a, b) => b.grossMargin - a.grossMargin);

  return {
    dim, from: from || null, to: to || null, segments,
    totals: {
      revenue: r2(segments.reduce((s, x) => s + x.revenue, 0)),
      variableCost: r2(segments.reduce((s, x) => s + x.variableCost, 0)),
      grossMargin: r2(segments.reduce((s, x) => s + x.grossMargin, 0)),
    },
  };
}

module.exports = { byDimension };
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.**
```bash
git add services/profitability.service.js tests/unit/services/profitability.service.test.js
git commit -m "feat(cost): profitability by customer/product/cost-centre (GL-native)"
```

---

## Task 7: breakEven.service

**Files:** Create `services/breakEven.service.js`; Test `tests/unit/services/breakEven.service.test.js`

- [ ] **Step 1: Write the failing test.**
```js
// tests/unit/services/breakEven.service.test.js
'use strict';
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockAggregate = jest.fn();
jest.mock('../../../models/JournalEntry.model', () => ({ aggregate: (...a) => mockAggregate(...a) }));
jest.mock('../../../repositories/transaction.repository', () => ({
  EFFECTIVE_LINES_STAGE: { $addFields: { effectiveLines: '$x' } }, REPORT_STATUSES: ['posted'],
}));
const be = require('../../../services/breakEven.service');

describe('breakEven.breakEvenPoint', () => {
  test('BEP units + revenue when price > variable', () => {
    const r = be.breakEvenPoint({ fixedCosts: 300000, pricePerUnit: 500, variableCostPerUnit: 300 });
    expect(r.feasible).toBe(true);
    expect(r.breakEvenUnits).toBe(1500);
    expect(r.breakEvenRevenue).toBe(750000);
    expect(r.cmPerUnit).toBe(200);
  });
  test('infeasible when price <= variable', () => {
    expect(be.breakEvenPoint({ fixedCosts: 1, pricePerUnit: 100, variableCostPerUnit: 100 }).feasible).toBe(false);
  });
});

describe('breakEven.whatIf', () => {
  test('projected profit and units for target profit', () => {
    const r = be.whatIf({ fixedCosts: 300000, pricePerUnit: 500, variableCostPerUnit: 300, expectedUnits: 2000, targetProfit: 100000 });
    expect(r.projectedProfit).toBe(100000);              // 2000*200 - 300000
    expect(r.unitsForTargetProfit).toBe(2000);           // (300000+100000)/200
  });
});

describe('breakEven.estimateFromActuals', () => {
  test('splits expenses into variable (Direct Cost) vs fixed', async () => {
    mockAggregate.mockResolvedValue([{ _id: null, revenue: 1000000, variableCosts: 600000, fixedCosts: 250000 }]);
    const r = await be.estimateFromActuals('biz1', { from: '2026-01-01', to: '2026-12-31' });
    expect(r).toMatchObject({ revenue: 1000000, variableCosts: 600000, fixedCosts: 250000 });
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
```js
// services/breakEven.service.js — FR-07.4 (pure compute + a read-only estimator)
'use strict';
const mongoose = require('mongoose');
const JournalEntry = require('../models/JournalEntry.model');
const { EFFECTIVE_LINES_STAGE, REPORT_STATUSES } = require('../repositories/transaction.repository');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const oid = (v) => new mongoose.Types.ObjectId(String(v));

function breakEvenPoint({ fixedCosts, pricePerUnit, variableCostPerUnit }) {
  const fc = Number(fixedCosts) || 0, p = Number(pricePerUnit) || 0, v = Number(variableCostPerUnit) || 0;
  const cmPerUnit = r2(p - v);
  if (cmPerUnit <= 0) return { feasible: false, reason: 'Price per unit must be greater than variable cost per unit.' };
  const exactUnits = fc / cmPerUnit;
  return {
    feasible: true,
    breakEvenUnits: Math.ceil(exactUnits),
    breakEvenUnitsExact: r2(exactUnits),
    breakEvenRevenue: r2(exactUnits * p),
    cmPerUnit,
    cmRatio: p ? r2(cmPerUnit / p) : null,
  };
}

function whatIf({ fixedCosts, pricePerUnit, variableCostPerUnit, expectedUnits = 0, targetProfit = 0 }) {
  const base = breakEvenPoint({ fixedCosts, pricePerUnit, variableCostPerUnit });
  const fc = Number(fixedCosts) || 0;
  if (!base.feasible) return { ...base, projectedProfit: null, unitsForTargetProfit: null };
  const cm = base.cmPerUnit;
  return {
    ...base,
    expectedUnits: Number(expectedUnits) || 0,
    projectedProfit: r2((Number(expectedUnits) || 0) * cm - fc),
    targetProfit: Number(targetProfit) || 0,
    unitsForTargetProfit: Math.ceil((fc + (Number(targetProfit) || 0)) / cm),
  };
}

async function estimateFromActuals(businessId, { from, to }) {
  const match = { businessId: oid(businessId), status: { $in: REPORT_STATUSES }, isArchived: { $ne: true } };
  if (from || to) { match.transactionDate = {}; if (from) match.transactionDate.$gte = new Date(from); if (to) match.transactionDate.$lte = new Date(to); }
  const [row] = await JournalEntry.aggregate([
    { $match: match },
    EFFECTIVE_LINES_STAGE,
    { $unwind: '$effectiveLines' },
    { $lookup: { from: 'chartofaccounts', localField: 'effectiveLines.accountId', foreignField: '_id',
      as: 'acc', pipeline: [{ $project: { accountType: 1, accountSubtype: 1 } }] } },
    { $unwind: { path: '$acc', preserveNullAndEmptyArrays: true } },
    { $group: {
      _id: null,
      revenue: { $sum: { $cond: [{ $and: [{ $eq: ['$acc.accountType', 'Revenue'] }, { $eq: ['$effectiveLines.type', 'credit'] }] }, '$effectiveLines.amount', 0] } },
      variableCosts: { $sum: { $cond: [{ $and: [{ $eq: ['$acc.accountSubtype', 'Direct Cost'] }, { $eq: ['$effectiveLines.type', 'debit'] }] }, '$effectiveLines.amount', 0] } },
      fixedCosts: { $sum: { $cond: [{ $and: [{ $eq: ['$acc.accountType', 'Expense'] }, { $ne: ['$acc.accountSubtype', 'Direct Cost'] }, { $eq: ['$effectiveLines.type', 'debit'] }] }, '$effectiveLines.amount', 0] } },
    } },
  ]);
  return { revenue: r2(row?.revenue), variableCosts: r2(row?.variableCosts), fixedCosts: r2(row?.fixedCosts) };
}

module.exports = { breakEvenPoint, whatIf, estimateFromActuals };
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.**
```bash
git add services/breakEven.service.js tests/unit/services/breakEven.service.test.js
git commit -m "feat(cost): break-even + what-if + estimate-from-actuals"
```

---

## Task 8: Validation + controller + routes + mount

**Files:** Create `validations/cost.validation.js`, `controllers/cost.controller.js`, `routes/v1/cost.routes.js`; Modify `routes/index.js`; Test `tests/unit/controllers/cost.controller.test.js`

- [ ] **Step 1: Validation (Joi, mirror existing style).**
```js
// validations/cost.validation.js — FR-07
'use strict';
const Joi = require('joi');
const objectId = Joi.string().hex().length(24);
const money = Joi.number().min(0);

const createJobSchema = Joi.object({
  code: Joi.string().max(40).required(),
  name: Joi.string().max(160).required(),
  customerId: objectId.allow(null, ''),
  standardCost: Joi.object({ material: money, labour: money, overhead: money }).default({}),
});
const addCostSchema = Joi.object({
  category: Joi.string().valid('material', 'labour', 'overhead').required(),
  amount: Joi.number().greater(0).required(),
  sourceAccountId: objectId.required(),
  description: Joi.string().allow('', null),
});
const breakEvenSchema = Joi.object({
  fixedCosts: money.required(), pricePerUnit: money.required(), variableCostPerUnit: money.required(),
});
const whatIfSchema = breakEvenSchema.keys({
  expectedUnits: Joi.number().min(0).default(0), targetProfit: Joi.number().default(0),
});
module.exports = { createJobSchema, addCostSchema, breakEvenSchema, whatIfSchema };
```

- [ ] **Step 2: Controller.**
```js
// controllers/cost.controller.js — FR-07.2/.3/.4
'use strict';
const ApiResponse = require('../utils/ApiResponse');
const jobCosting = require('../services/jobCosting.service');
const profitability = require('../services/profitability.service');
const breakEven = require('../services/breakEven.service');

const biz = (req) => req.user.businessId;
const actor = (req) => ({ id: req.user.id, role: req.user.role });

exports.listJobs = async (req, res, next) => { try { return ApiResponse.success(res, await jobCosting.listJobs(biz(req), { status: req.query.status, customerId: req.query.customerId })); } catch (e) { next(e); } };
exports.getJob = async (req, res, next) => { try { return ApiResponse.success(res, await jobCosting.getJob(biz(req), req.params.id)); } catch (e) { next(e); } };
exports.createJob = async (req, res, next) => { try { return ApiResponse.created(res, await jobCosting.createJob(biz(req), req.body, actor(req)), 'Job created.'); } catch (e) { next(e); } };
exports.addCost = async (req, res, next) => { try { return ApiResponse.success(res, await jobCosting.addCost(biz(req), req.params.id, req.body, actor(req)), 'Cost added.'); } catch (e) { next(e); } };
exports.completeJob = async (req, res, next) => { try { return ApiResponse.success(res, await jobCosting.completeJob(biz(req), req.params.id, actor(req)), 'Job completed.'); } catch (e) { next(e); } };
exports.cancelJob = async (req, res, next) => { try { return ApiResponse.success(res, await jobCosting.cancelJob(biz(req), req.params.id, actor(req)), 'Job cancelled.'); } catch (e) { next(e); } };
exports.profitability = async (req, res, next) => { try { return ApiResponse.success(res, await profitability.byDimension(biz(req), req.query.dim, { from: req.query.from, to: req.query.to })); } catch (e) { next(e); } };
exports.breakEven = async (req, res, next) => { try { return ApiResponse.success(res, breakEven.breakEvenPoint(req.body)); } catch (e) { next(e); } };
exports.whatIf = async (req, res, next) => { try { return ApiResponse.success(res, breakEven.whatIf(req.body)); } catch (e) { next(e); } };
exports.estimate = async (req, res, next) => { try { return ApiResponse.success(res, await breakEven.estimateFromActuals(biz(req), { from: req.query.from, to: req.query.to })); } catch (e) { next(e); } };
```

- [ ] **Step 3: Routes.**
```js
// routes/v1/cost.routes.js — FR-07
'use strict';
const express = require('express');
const ctrl = require('../../controllers/cost.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate = require('../../middleware/validate.middleware');
const { createJobSchema, addCostSchema, breakEvenSchema, whatIfSchema } = require('../../validations/cost.validation');

const router = express.Router();
router.use(authMiddleware);
router.use(requireBusiness);

router.get('/jobs', ctrl.listJobs);
router.post('/jobs', validate(createJobSchema), ctrl.createJob);
router.get('/jobs/:id', ctrl.getJob);
router.post('/jobs/:id/costs', validate(addCostSchema), ctrl.addCost);
router.post('/jobs/:id/complete', ctrl.completeJob);
router.post('/jobs/:id/cancel', ctrl.cancelJob);

router.get('/profitability', ctrl.profitability);
router.post('/break-even', validate(breakEvenSchema), ctrl.breakEven);
router.post('/what-if', validate(whatIfSchema), ctrl.whatIf);
router.get('/break-even/estimate', ctrl.estimate);

module.exports = router;
```

- [ ] **Step 4: Mount in `routes/index.js`** — after the `/budgets` line add:
```js
router.use('/cost',                  require('./v1/cost.routes'));        // SRS FR-07.2/.3/.4 — cost accounting
```

- [ ] **Step 5: Controller test.**
```js
// tests/unit/controllers/cost.controller.test.js
'use strict';
jest.mock('../../../services/jobCosting.service');
jest.mock('../../../services/profitability.service');
jest.mock('../../../services/breakEven.service');
const jobCosting = require('../../../services/jobCosting.service');
const breakEven = require('../../../services/breakEven.service');
const ctrl = require('../../../controllers/cost.controller');
const mkRes = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };
const req = (over = {}) => ({ user: { businessId: 'biz1', id: 'u1', role: 'owner' }, params: {}, query: {}, body: {}, ...over });
describe('cost.controller', () => {
  beforeEach(() => jest.clearAllMocks());
  test('createJob → 201', async () => {
    jobCosting.createJob.mockResolvedValue({ _id: 'j1' });
    const res = mkRes();
    await ctrl.createJob(req({ body: { code: 'J1' } }), res, jest.fn());
    expect(jobCosting.createJob).toHaveBeenCalledWith('biz1', { code: 'J1' }, expect.objectContaining({ id: 'u1' }));
    expect(res.status).toHaveBeenCalledWith(201);
  });
  test('breakEven delegates body to service', async () => {
    breakEven.breakEvenPoint.mockReturnValue({ feasible: true });
    const res = mkRes();
    await ctrl.breakEven(req({ body: { fixedCosts: 1, pricePerUnit: 2, variableCostPerUnit: 1 } }), res, jest.fn());
    expect(breakEven.breakEvenPoint).toHaveBeenCalledWith(expect.objectContaining({ fixedCosts: 1 }));
  });
});
```

- [ ] **Step 6: Run + verify route loads.**
Run: `npx jest tests/unit/controllers/cost.controller.test.js && node -e "require('./routes/v1/cost.routes'); console.log('route ok')"`
Expected: PASS + `route ok`

- [ ] **Step 7: Commit.**
```bash
git add validations/cost.validation.js controllers/cost.controller.js routes/v1/cost.routes.js routes/index.js tests/unit/controllers/cost.controller.test.js
git commit -m "feat(cost): validation + controller + routes, mount /cost"
```

---

## Task 9: Integration smoke + full-suite gate + push

**Files:** Create `tests/integration/cost.flow.test.js`

- [ ] **Step 1: Write the test (service-level, mocked models/posters).**
```js
// tests/integration/cost.flow.test.js
'use strict';
jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../repositories/job.repository');
jest.mock('../../repositories/account.repository', () => ({ findByCode: jest.fn(), findOneByBusinessAndId: jest.fn() }));
jest.mock('../../services/ledgerPosting.service', () => ({ postBalancedJournal: jest.fn() }));
const repo = require('../../repositories/job.repository');
const accountRepo = require('../../repositories/account.repository');
const ledger = require('../../services/ledgerPosting.service');
const jobCosting = require('../../services/jobCosting.service');

describe('cost flow (service integration)', () => {
  beforeEach(() => jest.clearAllMocks());
  test('create → add 2 costs → complete posts WIP→FG for the total', async () => {
    repo.findByCode.mockResolvedValue(null);
    repo.create.mockResolvedValue({ _id: 'j1', code: 'J1', status: 'open' });
    await jobCosting.createJob('biz1', { code: 'J1', name: 'Build', standardCost: { material: 500 } }, { id: 'u1' });

    const job = { _id: 'j1', businessId: 'biz1', code: 'J1', status: 'open', costSheet: [], wipJournalEntryIds: [], save: jest.fn() };
    repo.findOwnedById.mockResolvedValue(job);
    accountRepo.findByCode.mockImplementation((b, code) => Promise.resolve({ _id: code === '1150' ? 'fg' : 'wip' }));
    accountRepo.findOneByBusinessAndId.mockResolvedValue({ _id: 'cash' });
    let seq = 0; ledger.postBalancedJournal.mockImplementation(() => Promise.resolve({ _id: 'je' + (++seq) }));

    await jobCosting.addCost('biz1', 'j1', { category: 'material', amount: 300, sourceAccountId: 'cash' }, { id: 'u1' });
    await jobCosting.addCost('biz1', 'j1', { category: 'labour', amount: 200, sourceAccountId: 'cash' }, { id: 'u1' });
    expect(job.costSheet).toHaveLength(2);
    expect(job.status).toBe('in_progress');

    const done = await jobCosting.completeJob('biz1', 'j1', { id: 'u1' });
    const completionCall = ledger.postBalancedJournal.mock.calls.at(-1)[0];
    expect(completionCall).toMatchObject({ debitAccountId: 'fg', creditAccountId: 'wip', amount: 500 });
    expect(done.status).toBe('completed');
  });
});
```

- [ ] **Step 2: Run → PASS.**
- [ ] **Step 3: Full suite gate.**
Run: `npm test`
Expected: all green (prior baseline 147 suites / 1148 tests; this adds ~7 suites).
- [ ] **Step 4: Commit + push.**
```bash
git add tests/integration/cost.flow.test.js
git commit -m "test(cost): job flow create→cost→complete integration"
git push origin main
```

---

## Task 10: Frontend — service + 3 pages + nav + routes

**Files:** Create `src/services/cost.service.js`, `src/pages/cost/{JobCostingPage,ProfitabilityPage,BreakEvenPage}.jsx`; Modify `src/components/layout/nav.config.js`, `src/routes.jsx`.

First read `src/services/budget.service.js`, `src/pages/budget/VarianceDashboardPage.jsx`, `src/hooks/useAccounts.js`, `src/utils/exportHelpers.js` (`downloadBlob`) to mirror conventions.

- [ ] **Step 1: API service.**
```js
// src/services/cost.service.js — SRS FR-07
import api from './api'
const costService = {
  listJobs:   (params)   => api.get('/cost/jobs', { params }),
  getJob:     (id)       => api.get(`/cost/jobs/${id}`),
  createJob:  (data)     => api.post('/cost/jobs', data),
  addCost:    (id, data) => api.post(`/cost/jobs/${id}/costs`, data),
  complete:   (id)       => api.post(`/cost/jobs/${id}/complete`),
  cancel:     (id)       => api.post(`/cost/jobs/${id}/cancel`),
  profitability: (dim, from, to) => api.get('/cost/profitability', { params: { dim, from, to } }),
  breakEven:  (data)     => api.post('/cost/break-even', data),
  whatIf:     (data)     => api.post('/cost/what-if', data),
  estimate:   (from, to) => api.get('/cost/break-even/estimate', { params: { from, to } }),
}
export default costService
```

- [ ] **Step 2: JobCostingPage.jsx** — list jobs + create (code, name, standard material/labour/overhead). Selecting a job shows: Budget vs Actual per category with variance (green favourable / red over), an "Add cost" form (category select, amount, source account from `useAccounts`, description), and "Complete job" (when in_progress). Use `getErrorMessage` for toasts; `premium-card`, `btn-gradient`, theme classes (mirror payroll/variance pages). Money via `Number(n).toLocaleString('en-PK')`.

- [ ] **Step 3: ProfitabilityPage.jsx** — dimension switch (`customer` / `product` / `cost_center` labelled "Customers / Products / Departments"), date range; table per segment: Revenue, Variable cost, Gross margin, GM% (loss-makers shown with the `negative` colour + a "Loss" tag); totals row; **Export CSV** button building a CSV string from `segments` and calling `downloadBlob(new Blob([csv], { type: 'text/csv' }), 'profitability.csv')`.

- [ ] **Step 4: BreakEvenPage.jsx** — inputs fixed costs / price per unit / variable cost per unit; "Fill from my numbers" calls `estimate(from,to)` and maps `{fixedCosts, variableCosts, revenue}` into the fields (variable per unit left for the user, or prefilled if they enter expected units); shows break-even units + revenue (calls `breakEven`); what-if section with expected units + target profit → calls `whatIf` (or computes client-side) showing projected profit; allow adding several scenarios into a comparison list (client-side state). Infeasible (`feasible:false`) shows the reason.

- [ ] **Step 5: Nav** — in `src/components/layout/nav.config.js` add a **"Cost & Profit"** section (GOLD accent; import an icon e.g. `Hammer` or reuse `Briefcase`) with items: `{ name: 'Jobs', href: '/cost/jobs' }`, `{ name: 'Profitability', href: '/cost/profitability' }`, `{ name: 'Break-even', href: '/cost/break-even' }`.

- [ ] **Step 6: Routes** — in `src/routes.jsx` add lazy imports + routes (mirror budget entries):
```jsx
const JobCostingPage     = lazy(() => import('@/pages/cost/JobCostingPage'))     // SRS FR-07.2
const ProfitabilityPage  = lazy(() => import('@/pages/cost/ProfitabilityPage'))  // SRS FR-07.3
const BreakEvenPage      = lazy(() => import('@/pages/cost/BreakEvenPage'))      // SRS FR-07.4
// inside RequireBusiness children:
{ path: 'cost/jobs',          element: withSuspense(JobCostingPage)    },
{ path: 'cost/profitability', element: withSuspense(ProfitabilityPage) },
{ path: 'cost/break-even',    element: withSuspense(BreakEvenPage)      },
```

- [ ] **Step 7: Build + lint.**
Run (in `vousfin-frontend-main/`): `npm run build && npx eslint src/pages/cost src/services/cost.service.js src/components/layout/nav.config.js src/routes.jsx`
Expected: build OK, lint clean.

- [ ] **Step 8: Commit + push.**
```bash
git add src/services/cost.service.js src/pages/cost src/components/layout/nav.config.js src/routes.jsx
git commit -m "feat(cost): frontend job costing + profitability + break-even"
git push origin main
```

---

## Task 11: Live verification + finalize

- [ ] **Step 1: Self-cleaning live smoke** (throwaway script in backend dir, deleted after; mirror prior phases). Pick a business with a Cash + Direct-Cost account (e.g. ABC Trading): create a job → add a material cost (Dr WIP/Cr Cash) and a labour cost → assert WIP balance rose by the total → complete (Dr Inventory/Cr WIP) → assert WIP nets back to 0 and Inventory rose → run `profitability.byDimension(... 'customer')` over a date window (asserts it returns shape) → `breakEven.breakEvenPoint` sanity → reverse/delete the job's JEs and the job → `recomputeLedgerBalances <biz> --apply` → assert drift 0. Delete the script.
- [ ] **Step 2: Drift guard.** Run `node scripts/ledgerDrift.js` → every business drift 0.
- [ ] **Step 3: Final full backend suite.** `npm test` → green.
- [ ] **Step 4: Update memory** `srs-gap-closure-plan.md` — Phase 4 done with backend/frontend HEADs, the GL-native profitability decision, the WIP/FG posting, gotchas; "Next: Phase 5 Equity statement + Report builder".
- [ ] **Step 5: Plain-language summary to the user.**

---

## Self-Review

**Spec coverage:** FR-07.2 job costing → Tasks 2–5 (model, WIP posting, completion WIP→FG, 3-way variance). FR-07.3 profitability → Task 6 (customer/product/cost_center, CM/GM, loss-maker, CSV export in Task 10). FR-07.4 break-even/what-if → Task 7 (BEP, whatIf, estimateFromActuals). Routes/UI → Tasks 8/10. ✓

**Placeholder scan:** Frontend pages (Task 10 steps 2–4) are described by contract rather than full JSX — intentional (large, must match live conventions); every API/data shape they consume is fully defined in Tasks 6–8. No backend step has a placeholder.

**Type consistency:** account codes `1169`/`1150` consistent (Tasks 4/5). `computeActuals`/`computeVariance` shapes match between service (Task 4/5) and `getJob`. Profitability segment shape `{id,name,revenue,variableCost,grossMargin,grossMarginPct,contributionMargin,lossMaker}` consistent (Task 6 ↔ Task 10). `breakEvenPoint`/`whatIf` field names (`breakEvenUnits`, `cmPerUnit`, `projectedProfit`, `unitsForTargetProfit`) consistent (Task 7 ↔ Task 10). Job posting always `inputMethod:'form'` + `createdBy` (matches the model's required fields and the fiscal-year fix).

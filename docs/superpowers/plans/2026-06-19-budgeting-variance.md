# Budgeting & Variance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a business plan income/spending per account (a versioned, approved, multi-scenario **budget**), then continuously compare the live GL against it (**variance**) and alert within 60s when an account drifts past threshold.

**Architecture:** New `Budget` model (versioned, immutable once active, three scenarios) + `budget.service` (create/seed/approve/clone reusing `approvalEngine`) + `variance.service` (actuals read through the canonical `EFFECTIVE_LINES_STAGE` in base currency, sign-corrected per account type, RAG-banded) + an event subscriber on `transaction.created`/`transaction.reversed` that fires a deduped `FinancialAlert`. Thin controller/routes mirror the payroll module; React editor + variance dashboard mirror existing pages.

**Tech Stack:** Node/Express/Mongoose 9, Jest (mocked models — never `{ virtual:true }`), React 19/Vite/TanStack Query/Zustand.

**Spec:** `docs/superpowers/specs/2026-06-19-budgeting-variance-design.md`

---

## File Structure

**Backend (create):**
- `models/Budget.model.js` — schema, indexes, `canTransition` static
- `repositories/budget.repository.js` — `findActive`, `findVersions`, `findOwned`
- `services/budget.service.js` — lifecycle (draft/seed/submit/approve/reject/clone)
- `services/variance.service.js` — `actualsByLine`, `computeVariance`, `checkBreaches`
- `validations/budget.validation.js` — Joi schemas
- `controllers/budget.controller.js` — thin
- `routes/v1/budget.routes.js` — routes
- `__tests__/services/budget.service.test.js`
- `__tests__/services/variance.service.test.js`
- `__tests__/services/budgetVariance.subscriber.test.js`
- `tests/integration/budget.flow.test.js`

**Backend (modify):**
- `config/constants.js` — `BUDGET_STATUS`, `BUDGET_STATUS_TRANSITIONS`, `BUDGET_SCENARIOS`
- `repositories/transaction.repository.js` — export `REPORT_STATUSES`
- `services/eventSubscribers.service.js` — register budget-variance subscriber
- `routes/index.js` — mount `/budgets`

**Frontend (create):**
- `src/services/budget.service.js`
- `src/pages/budget/BudgetEditorPage.jsx`
- `src/pages/budget/VarianceDashboardPage.jsx`

**Frontend (modify):**
- `src/config/nav.config.js` — "Budgets" section
- `src/routes.jsx` — lazy routes

---

## Task 1: Budget constants

**Files:**
- Modify: `config/constants.js`

- [ ] **Step 1: Add constants near the payroll constants block.** Find `PAYROLL_RUN_TRANSITIONS` and add AFTER its closing block:

```js
// ── Budgeting (FR-04.1 / FR-04.2) ──────────────────────────────────────────
const BUDGET_STATUS = Object.freeze({
  DRAFT: 'draft',
  PENDING_APPROVAL: 'pending_approval',
  ACTIVE: 'active',
  REJECTED: 'rejected',
  ARCHIVED: 'archived',
});

const BUDGET_STATUS_TRANSITIONS = Object.freeze({
  draft:            ['pending_approval'],
  pending_approval: ['active', 'rejected'],
  rejected:         ['draft'],
  active:           ['archived'],
  archived:         [],
});

const BUDGET_SCENARIOS = Object.freeze(['base', 'optimistic', 'pessimistic']);
```

- [ ] **Step 2: Export them.** In the bottom `module.exports = { ... }`, add `BUDGET_STATUS, BUDGET_STATUS_TRANSITIONS, BUDGET_SCENARIOS,`.

- [ ] **Step 3: Verify it loads.**

Run: `node -e "const c=require('./config/constants'); console.log(c.BUDGET_STATUS.ACTIVE, c.BUDGET_SCENARIOS.length, c.BUDGET_STATUS_TRANSITIONS.pending_approval)"`
Expected: `active 3 [ 'active', 'rejected' ]`

- [ ] **Step 4: Commit.**

```bash
git add config/constants.js
git commit -m "feat(budget): budget status/scenario constants"
```

---

## Task 2: Budget model

**Files:**
- Create: `models/Budget.model.js`
- Test: `__tests__/models/budget.model.test.js`

- [ ] **Step 1: Write the failing test.**

```js
// __tests__/models/budget.model.test.js
'use strict';
const Budget = require('../../models/Budget.model');

describe('Budget model', () => {
  test('canTransition follows BUDGET_STATUS_TRANSITIONS', () => {
    expect(Budget.canTransition('draft', 'pending_approval')).toBe(true);
    expect(Budget.canTransition('pending_approval', 'active')).toBe(true);
    expect(Budget.canTransition('pending_approval', 'rejected')).toBe(true);
    expect(Budget.canTransition('active', 'draft')).toBe(false);
    expect(Budget.canTransition('archived', 'active')).toBe(false);
  });

  test('defaults: scenario=base, version=1, status=draft, defaultThresholdPct=10', () => {
    const b = new Budget({ businessId: '64b000000000000000000001', name: 'X',
      fiscalYearId: '64b000000000000000000002', createdBy: '64b000000000000000000003' });
    expect(b.scenario).toBe('base');
    expect(b.version).toBe(1);
    expect(b.status).toBe('draft');
    expect(b.defaultThresholdPct).toBe(10);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx jest __tests__/models/budget.model.test.js -v`
Expected: FAIL — `Cannot find module '../../models/Budget.model'`

- [ ] **Step 3: Implement the model.**

```js
// models/Budget.model.js — FR-04.1 / FR-04.2
'use strict';
const mongoose = require('mongoose');
const { BUDGET_STATUS, BUDGET_STATUS_TRANSITIONS, BUDGET_SCENARIOS } = require('../config/constants');

const budgetLineSchema = new mongoose.Schema({
  accountId:    { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', required: true },
  costCenterId: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
  monthly:      { type: [Number], default: () => Array(12).fill(0),
                  validate: { validator: (a) => Array.isArray(a) && a.length === 12,
                              message: 'monthly must have exactly 12 values' } },
  thresholdPct: { type: Number, default: null },
}, { _id: false });

const budgetSchema = new mongoose.Schema({
  businessId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  name:         { type: String, required: true, trim: true, maxlength: 120 },
  fiscalYearId: { type: mongoose.Schema.Types.ObjectId, ref: 'FiscalYear', required: true },
  scenario:     { type: String, enum: BUDGET_SCENARIOS, default: 'base' },
  version:      { type: Number, default: 1 },
  status:       { type: String, enum: Object.values(BUDGET_STATUS), default: BUDGET_STATUS.DRAFT },
  defaultThresholdPct: { type: Number, default: 10 },
  approvalChain: { type: Array, default: [] },
  createdBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  lines:        { type: [budgetLineSchema], default: [] },
}, { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } });

budgetSchema.index({ businessId: 1, fiscalYearId: 1, scenario: 1, version: 1 });
// At most one active budget per scenario per fiscal year.
budgetSchema.index(
  { businessId: 1, fiscalYearId: 1, scenario: 1 },
  { unique: true, partialFilterExpression: { status: BUDGET_STATUS.ACTIVE } }
);

budgetSchema.statics.canTransition = (from, to) =>
  (BUDGET_STATUS_TRANSITIONS[from] || []).includes(to);

module.exports = mongoose.model('Budget', budgetSchema);
```

- [ ] **Step 4: Run to verify it passes.**

Run: `npx jest __tests__/models/budget.model.test.js -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit.**

```bash
git add models/Budget.model.js __tests__/models/budget.model.test.js
git commit -m "feat(budget): Budget model with versioning + active-uniqueness index"
```

---

## Task 3: Budget repository

**Files:**
- Create: `repositories/budget.repository.js`
- Test: `__tests__/repositories/budget.repository.test.js`

- [ ] **Step 1: Write the failing test.**

```js
// __tests__/repositories/budget.repository.test.js
'use strict';
jest.mock('../../models/Budget.model', () => {
  const m = function () {};
  m.find = jest.fn();
  m.findOne = jest.fn();
  return m;
});
const Budget = require('../../models/Budget.model');
const repo = require('../../repositories/budget.repository');

const chain = (result) => ({ sort: () => ({ lean: () => Promise.resolve(result) }), lean: () => Promise.resolve(result) });

describe('budget.repository', () => {
  beforeEach(() => jest.clearAllMocks());

  test('findActive queries businessId+fy+scenario+status=active', async () => {
    Budget.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'b1' }) });
    const r = await repo.findActive('biz1', 'fy1', 'base');
    expect(Budget.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: 'biz1', fiscalYearId: 'fy1', scenario: 'base', status: 'active' }));
    expect(r._id).toBe('b1');
  });

  test('findVersions sorts by version desc', async () => {
    const sort = jest.fn(() => ({ lean: () => Promise.resolve([{ version: 2 }, { version: 1 }]) }));
    Budget.find.mockReturnValue({ sort });
    const r = await repo.findVersions('biz1', 'fy1', 'base');
    expect(sort).toHaveBeenCalledWith({ version: -1 });
    expect(r[0].version).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx jest __tests__/repositories/budget.repository.test.js -v`
Expected: FAIL — cannot find `budget.repository`.

- [ ] **Step 3: Implement.**

```js
// repositories/budget.repository.js
'use strict';
const BaseRepository = require('./base.repository');
const Budget = require('../models/Budget.model');
const { BUDGET_STATUS } = require('../config/constants');

class BudgetRepository extends BaseRepository {
  constructor() { super(Budget); }

  findActive(businessId, fiscalYearId, scenario) {
    return this.model.findOne({
      businessId, fiscalYearId, scenario, status: BUDGET_STATUS.ACTIVE,
    }).lean();
  }

  findVersions(businessId, fiscalYearId, scenario) {
    return this.model.find({ businessId, fiscalYearId, scenario }).sort({ version: -1 }).lean();
  }

  findOwned(businessId, filters = {}) {
    const q = { businessId };
    if (filters.fiscalYearId) q.fiscalYearId = filters.fiscalYearId;
    if (filters.scenario)     q.scenario = filters.scenario;
    if (filters.status)       q.status = filters.status;
    return this.model.find(q).sort({ createdAt: -1 }).lean();
  }

  findOwnedById(businessId, id) {
    return this.model.findOne({ _id: id, businessId });
  }

  findActiveByFiscalYear(businessId, fiscalYearId) {
    return this.model.find({ businessId, fiscalYearId, status: BUDGET_STATUS.ACTIVE });
  }
}

module.exports = new BudgetRepository();
```

- [ ] **Step 4: Run to verify it passes.**

Run: `npx jest __tests__/repositories/budget.repository.test.js -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit.**

```bash
git add repositories/budget.repository.js __tests__/repositories/budget.repository.test.js
git commit -m "feat(budget): budget repository (findActive/findVersions/findOwned)"
```

---

## Task 4: budget.service — splitEvenly + createDraft + updateDraft

**Files:**
- Create: `services/budget.service.js`
- Test: `__tests__/services/budget.service.test.js`

- [ ] **Step 1: Write the failing test.**

```js
// __tests__/services/budget.service.test.js
'use strict';
jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../repositories/budget.repository');
jest.mock('../../services/costCenter.service', () => ({ validateAssignable: jest.fn().mockResolvedValue(null) }));

const repo = require('../../repositories/budget.repository');
const budget = require('../../services/budget.service');

describe('budget.service — splitEvenly', () => {
  test('splits evenly and absorbs rounding remainder in the last month', () => {
    const r = budget.splitEvenly(1200);
    expect(r).toHaveLength(12);
    expect(r.every((m) => m === 100)).toBe(true);
    expect(r.reduce((a, b) => a + b, 0)).toBe(1200);
  });
  test('remainder preserved so sum === annual', () => {
    const r = budget.splitEvenly(1000);
    expect(r.reduce((a, b) => a + b, 0)).toBe(1000);
  });
  test('zero / falsy → all zeros', () => {
    expect(budget.splitEvenly(0)).toEqual(Array(12).fill(0));
  });
});

describe('budget.service — createDraft', () => {
  beforeEach(() => jest.clearAllMocks());
  test('creates a version-1 draft owned by the user', async () => {
    repo.create.mockResolvedValue({ _id: 'b1', status: 'draft', version: 1 });
    const out = await budget.createDraft('biz1',
      { name: 'FY26', fiscalYearId: 'fy1', scenario: 'base',
        lines: [{ accountId: 'a1', monthly: Array(12).fill(50) }] },
      { id: 'u1' });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
      businessId: 'biz1', name: 'FY26', version: 1, status: 'draft', createdBy: 'u1' }));
    expect(out._id).toBe('b1');
  });
});

describe('budget.service — updateDraft', () => {
  beforeEach(() => jest.clearAllMocks());
  test('rejects editing a non-draft budget', async () => {
    repo.findOwnedById.mockResolvedValue({ _id: 'b1', status: 'active' });
    await expect(budget.updateDraft('biz1', 'b1', { name: 'x' }, { id: 'u1' }))
      .rejects.toThrow(/only.*draft/i);
  });
  test('updates a draft', async () => {
    repo.findOwnedById.mockResolvedValue({ _id: 'b1', status: 'draft' });
    repo.update.mockResolvedValue({ _id: 'b1', name: 'new' });
    const out = await budget.updateDraft('biz1', 'b1', { name: 'new' }, { id: 'u1' });
    expect(out.name).toBe('new');
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx jest __tests__/services/budget.service.test.js -v`
Expected: FAIL — cannot find `budget.service`.

- [ ] **Step 3: Implement the service (this file grows over Tasks 4–6).**

```js
// services/budget.service.js — FR-04.1
'use strict';
const { ApiError } = require('../utils/ApiError');
const { BUDGET_STATUS } = require('../config/constants');
const repo = require('../repositories/budget.repository');
const costCenterService = require('../services/costCenter.service');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Split an annual amount evenly across 12 months; the last month absorbs the
 *  rounding remainder so the months always sum back to the annual figure. */
function splitEvenly(annualAmount) {
  const annual = Number(annualAmount) || 0;
  if (!annual) return Array(12).fill(0);
  const per = round2(annual / 12);
  const months = Array(11).fill(per);
  months.push(round2(annual - per * 11));
  return months;
}

async function _validateLines(businessId, lines = []) {
  for (const line of lines) {
    if (line.costCenterId) await costCenterService.validateAssignable(businessId, line.costCenterId);
  }
}

async function createDraft(businessId, payload, user) {
  if (!payload.fiscalYearId) throw new ApiError(400, 'A fiscal year is required.');
  await _validateLines(businessId, payload.lines);
  return repo.create({
    businessId,
    name: payload.name,
    fiscalYearId: payload.fiscalYearId,
    scenario: payload.scenario || 'base',
    version: 1,
    status: BUDGET_STATUS.DRAFT,
    defaultThresholdPct: payload.defaultThresholdPct != null ? payload.defaultThresholdPct : 10,
    createdBy: user.id,
    lines: (payload.lines || []).map((l) => ({
      accountId: l.accountId,
      costCenterId: l.costCenterId || null,
      monthly: Array.isArray(l.monthly) && l.monthly.length === 12 ? l.monthly.map(round2) : Array(12).fill(0),
      thresholdPct: l.thresholdPct != null ? l.thresholdPct : null,
    })),
  });
}

async function updateDraft(businessId, id, payload, user) {
  const doc = await repo.findOwnedById(businessId, id);
  if (!doc) throw new ApiError(404, 'Budget not found.');
  if (doc.status !== BUDGET_STATUS.DRAFT) {
    throw new ApiError(409, 'You can only edit a budget while it is a draft. Clone it to make a new version.');
  }
  if (payload.lines) await _validateLines(businessId, payload.lines);
  const update = {};
  if (payload.name != null) update.name = payload.name;
  if (payload.defaultThresholdPct != null) update.defaultThresholdPct = payload.defaultThresholdPct;
  if (payload.lines) {
    update.lines = payload.lines.map((l) => ({
      accountId: l.accountId,
      costCenterId: l.costCenterId || null,
      monthly: Array.isArray(l.monthly) && l.monthly.length === 12 ? l.monthly.map(round2) : Array(12).fill(0),
      thresholdPct: l.thresholdPct != null ? l.thresholdPct : null,
    }));
  }
  return repo.update(id, update);
}

async function getById(businessId, id) {
  const doc = await repo.findOwnedById(businessId, id);
  if (!doc) throw new ApiError(404, 'Budget not found.');
  return doc;
}

async function list(businessId, filters) { return repo.findOwned(businessId, filters); }

module.exports = { splitEvenly, createDraft, updateDraft, getById, list };
```

- [ ] **Step 4: Run to verify it passes.**

Run: `npx jest __tests__/services/budget.service.test.js -v`
Expected: PASS (splitEvenly ×3, createDraft ×1, updateDraft ×2)

- [ ] **Step 5: Commit.**

```bash
git add services/budget.service.js __tests__/services/budget.service.test.js
git commit -m "feat(budget): budget.service splitEvenly + createDraft + updateDraft"
```

---

## Task 5: budget.service — seedFromActuals

**Files:**
- Modify: `services/budget.service.js`
- Modify: `__tests__/services/budget.service.test.js`

`seedFromActuals` returns a non-persisted preview: for the **prior** fiscal year, it pulls each account's actuals split per fiscal month, so the editor pre-fills the grid. It delegates the heavy aggregation to `variance.actualsByMonth` (built in Task 7) — to keep Task 5 testable in isolation we mock that call.

- [ ] **Step 1: Add the failing test** to `budget.service.test.js`:

```js
jest.mock('../../services/variance.service', () => ({
  actualsByMonth: jest.fn(),
}));
jest.mock('../../repositories/fiscalYear.repository', () => ({
  findOwnedById: jest.fn(),
  findPrior: jest.fn(),
}), { virtual: false });

const variance = require('../../services/variance.service');
const fyRepo = require('../../repositories/fiscalYear.repository');

describe('budget.service — seedFromActuals', () => {
  beforeEach(() => jest.clearAllMocks());
  test('builds a line per account from the prior year actuals, split by month', async () => {
    fyRepo.findOwnedById.mockResolvedValue({ _id: 'fy2', startDate: new Date('2026-07-01'), endDate: new Date('2027-06-30') });
    fyRepo.findPrior.mockResolvedValue({ _id: 'fy1', startDate: new Date('2025-07-01'), endDate: new Date('2026-06-30') });
    variance.actualsByMonth.mockResolvedValue([
      { accountId: 'a1', costCenterId: null, monthly: [10,10,10,10,10,10,10,10,10,10,10,10] },
    ]);
    const out = await budget.seedFromActuals('biz1', 'fy2', { scenario: 'base' });
    expect(out.fiscalYearId).toBe('fy2');
    expect(out.scenario).toBe('base');
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].accountId).toBe('a1');
    expect(out.lines[0].monthly).toHaveLength(12);
  });
  test('returns empty lines when there is no prior year', async () => {
    fyRepo.findOwnedById.mockResolvedValue({ _id: 'fy2', startDate: new Date('2026-07-01'), endDate: new Date('2027-06-30') });
    fyRepo.findPrior.mockResolvedValue(null);
    const out = await budget.seedFromActuals('biz1', 'fy2', {});
    expect(out.lines).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail.**

Run: `npx jest __tests__/services/budget.service.test.js -t seedFromActuals -v`
Expected: FAIL — `budget.seedFromActuals is not a function`.

- [ ] **Step 3: Add `findPrior` to the fiscal-year repository.** First check whether `repositories/fiscalYear.repository.js` exists:

Run: `ls repositories/fiscalYear.repository.js`

If it exists, add these methods to the class (before `module.exports`); if it does not exist, create the file:

```js
// repositories/fiscalYear.repository.js  (create if missing)
'use strict';
const BaseRepository = require('./base.repository');
const FiscalYear = require('../models/FiscalYear.model');

class FiscalYearRepository extends BaseRepository {
  constructor() { super(FiscalYear); }
  findOwnedById(businessId, id) { return this.model.findOne({ _id: id, businessId }).lean(); }
  /** The fiscal year immediately preceding the given one (ends on/just before its start). */
  findPrior(businessId, startDate) {
    return this.model.findOne({ businessId, endDate: { $lte: new Date(startDate) } })
      .sort({ endDate: -1 }).lean();
  }
}
module.exports = new FiscalYearRepository();
```

> If the file already exists with a different export shape, add `findOwnedById` and `findPrior` to match the test's `fyRepo.findOwnedById` / `fyRepo.findPrior` calls.

- [ ] **Step 4: Implement `seedFromActuals` in `budget.service.js`.** Add the require at the top and the function before `module.exports`:

```js
const fyRepo = require('../repositories/fiscalYear.repository');
// lazy-require variance.service inside the function to avoid a load-time cycle
```

```js
async function seedFromActuals(businessId, fiscalYearId, { scenario = 'base' } = {}) {
  const fy = await fyRepo.findOwnedById(businessId, fiscalYearId);
  if (!fy) throw new ApiError(404, 'Fiscal year not found.');
  const prior = await fyRepo.findPrior(businessId, fy.startDate);
  if (!prior) return { fiscalYearId, scenario, lines: [] };
  const variance = require('./variance.service');
  const rows = await variance.actualsByMonth(businessId, { from: prior.startDate, to: prior.endDate });
  return {
    fiscalYearId,
    scenario,
    lines: rows.map((r) => ({
      accountId: r.accountId,
      costCenterId: r.costCenterId || null,
      monthly: (Array.isArray(r.monthly) && r.monthly.length === 12 ? r.monthly : Array(12).fill(0)).map(round2),
      thresholdPct: null,
    })),
  };
}
```

Add `seedFromActuals` to `module.exports`.

- [ ] **Step 5: Run to verify it passes.**

Run: `npx jest __tests__/services/budget.service.test.js -v`
Expected: PASS (all budget.service tests, incl. 2 seed tests)

- [ ] **Step 6: Commit.**

```bash
git add services/budget.service.js repositories/fiscalYear.repository.js __tests__/services/budget.service.test.js
git commit -m "feat(budget): seedFromActuals + fiscalYear repo findPrior"
```

---

## Task 6: budget.service — submit / approve / reject / clone (lifecycle)

**Files:**
- Modify: `services/budget.service.js`
- Modify: `__tests__/services/budget.service.test.js`

- [ ] **Step 1: Add failing tests.**

```js
jest.mock('../../services/approvalEngine.service', () => ({
  buildChain: jest.fn(() => [{ sequence: 1, level: 'FINANCE', status: 'pending' }]),
  approveStep: jest.fn(() => ({ fullyApproved: true })),
  rejectStep: jest.fn(() => ({ rejected: true })),
  summarize: jest.fn(() => ({ complete: true })),
}));
const approvalEngine = require('../../services/approvalEngine.service');

describe('budget.service — lifecycle', () => {
  beforeEach(() => jest.clearAllMocks());

  test('submitForApproval builds chain and moves draft → pending_approval', async () => {
    repo.findOwnedById.mockResolvedValue({ _id: 'b1', status: 'draft', lines: [{ monthly: Array(12).fill(100) }] });
    repo.update.mockImplementation((id, u) => Promise.resolve({ _id: id, ...u }));
    const out = await budget.submitForApproval('biz1', 'b1', { id: 'u1' });
    expect(approvalEngine.buildChain).toHaveBeenCalled();
    expect(out.status).toBe('pending_approval');
  });

  test('submit rejects when not draft', async () => {
    repo.findOwnedById.mockResolvedValue({ _id: 'b1', status: 'active', lines: [] });
    await expect(budget.submitForApproval('biz1', 'b1', { id: 'u1' })).rejects.toThrow(/draft/i);
  });

  test('approve to completion → active and archives prior active of same fy+scenario', async () => {
    repo.findOwnedById.mockResolvedValue({ _id: 'b2', status: 'pending_approval', approvalChain: [{}],
      fiscalYearId: 'fy1', scenario: 'base', createdBy: 'creator' });
    repo.findActive.mockResolvedValue({ _id: 'bOld' });
    repo.update.mockImplementation((id, u) => Promise.resolve({ _id: id, ...u }));
    const out = await budget.approve('biz1', 'b2', { _id: 'approver', id: 'approver' }, 'ok');
    expect(approvalEngine.approveStep).toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith('bOld', { status: 'archived' });
    expect(out.status).toBe('active');
  });

  test('reject → rejected', async () => {
    repo.findOwnedById.mockResolvedValue({ _id: 'b2', status: 'pending_approval', approvalChain: [{}], createdBy: 'creator' });
    repo.update.mockImplementation((id, u) => Promise.resolve({ _id: id, ...u }));
    const out = await budget.reject('biz1', 'b2', { _id: 'approver', id: 'approver' }, 'no');
    expect(out.status).toBe('rejected');
  });

  test('cloneVersion creates draft at version+1 copying lines', async () => {
    repo.findOwnedById.mockResolvedValue({ _id: 'b1', version: 2, name: 'FY26',
      fiscalYearId: 'fy1', scenario: 'base', defaultThresholdPct: 10,
      lines: [{ accountId: 'a1', costCenterId: null, monthly: Array(12).fill(5), thresholdPct: null }] });
    repo.create.mockImplementation((d) => Promise.resolve({ _id: 'bNew', ...d }));
    const out = await budget.cloneVersion('biz1', 'b1', { id: 'u1' });
    expect(out.version).toBe(3);
    expect(out.status).toBe('draft');
    expect(out.lines).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail.**

Run: `npx jest __tests__/services/budget.service.test.js -t lifecycle -v`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement.** Add the require and functions in `budget.service.js`:

```js
const approvalEngine = require('./approvalEngine.service');
const Budget = require('../models/Budget.model');

const annualTotal = (doc) =>
  (doc.lines || []).reduce((s, l) => s + (l.monthly || []).reduce((a, b) => a + (Number(b) || 0), 0), 0);

async function submitForApproval(businessId, id, user) {
  const doc = await repo.findOwnedById(businessId, id);
  if (!doc) throw new ApiError(404, 'Budget not found.');
  if (doc.status !== BUDGET_STATUS.DRAFT) throw new ApiError(409, 'Only a draft budget can be submitted for approval.');
  const approvalChain = approvalEngine.buildChain(annualTotal(doc));
  return repo.update(id, { approvalChain, status: BUDGET_STATUS.PENDING_APPROVAL });
}

async function approve(businessId, id, user, note) {
  const doc = await repo.findOwnedById(businessId, id);
  if (!doc) throw new ApiError(404, 'Budget not found.');
  if (doc.status !== BUDGET_STATUS.PENDING_APPROVAL) throw new ApiError(409, 'This budget is not awaiting approval.');
  const { fullyApproved } = approvalEngine.approveStep(doc, user, note); // throws on SoD / role
  if (!fullyApproved) {
    return repo.update(id, { approvalChain: doc.approvalChain });
  }
  // Final approval: activate, archive the prior active of the same fy+scenario.
  const prior = await repo.findActive(businessId, doc.fiscalYearId, doc.scenario);
  if (prior && String(prior._id) !== String(id)) {
    await repo.update(prior._id, { status: BUDGET_STATUS.ARCHIVED });
  }
  return repo.update(id, { approvalChain: doc.approvalChain, status: BUDGET_STATUS.ACTIVE });
}

async function reject(businessId, id, user, note) {
  const doc = await repo.findOwnedById(businessId, id);
  if (!doc) throw new ApiError(404, 'Budget not found.');
  if (doc.status !== BUDGET_STATUS.PENDING_APPROVAL) throw new ApiError(409, 'This budget is not awaiting approval.');
  approvalEngine.rejectStep(doc, user, note);
  return repo.update(id, { approvalChain: doc.approvalChain, status: BUDGET_STATUS.REJECTED });
}

async function cloneVersion(businessId, id, user) {
  const doc = await repo.findOwnedById(businessId, id);
  if (!doc) throw new ApiError(404, 'Budget not found.');
  return repo.create({
    businessId,
    name: doc.name,
    fiscalYearId: doc.fiscalYearId,
    scenario: doc.scenario,
    version: (doc.version || 1) + 1,
    status: BUDGET_STATUS.DRAFT,
    defaultThresholdPct: doc.defaultThresholdPct,
    createdBy: user.id,
    approvalChain: [],
    lines: (doc.lines || []).map((l) => ({
      accountId: l.accountId, costCenterId: l.costCenterId || null,
      monthly: [...(l.monthly || Array(12).fill(0))], thresholdPct: l.thresholdPct != null ? l.thresholdPct : null,
    })),
  });
}
```

Add `submitForApproval, approve, reject, cloneVersion` to `module.exports`.

> Note: `approvalEngine.approveStep`/`rejectStep` mutate `doc.approvalChain` and enforce SoD (creator ≠ approver) and role. Because `repo.findOwnedById` returns a live Mongoose doc (not `.lean()`), the mutation persists via `repo.update(id, { approvalChain: doc.approvalChain })`.

- [ ] **Step 4: Run to verify they pass.**

Run: `npx jest __tests__/services/budget.service.test.js -v`
Expected: PASS (all budget.service tests)

- [ ] **Step 5: Commit.**

```bash
git add services/budget.service.js __tests__/services/budget.service.test.js
git commit -m "feat(budget): approval lifecycle submit/approve/reject + cloneVersion"
```

---

## Task 7: variance.service — actuals aggregation

**Files:**
- Create: `services/variance.service.js`
- Modify: `repositories/transaction.repository.js` (export `REPORT_STATUSES`)
- Test: `__tests__/services/variance.service.test.js`

`actualsByLine` returns per-`accountId|costCenterId` debit/credit sums over a date range; `actualsByMonth` returns per-account 12-element monthly arrays (used by seedFromActuals). Both read through `EFFECTIVE_LINES_STAGE` (base currency, compound-aware).

- [ ] **Step 1: Export `REPORT_STATUSES`** in `repositories/transaction.repository.js`. After the line `transactionRepository.EFFECTIVE_LINES_STAGE = EFFECTIVE_LINES_STAGE;` add:

```js
transactionRepository.REPORT_STATUSES = REPORT_STATUSES;
```

- [ ] **Step 2: Write the failing test.**

```js
// __tests__/services/variance.service.test.js
'use strict';
jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockAggregate = jest.fn();
jest.mock('../../models/JournalEntry.model', () => ({ aggregate: (...a) => mockAggregate(...a) }));
jest.mock('../../repositories/transaction.repository', () => ({
  EFFECTIVE_LINES_STAGE: { $addFields: { effectiveLines: '$x' } },
  REPORT_STATUSES: ['posted', 'partially_settled', 'settled'],
}));

const variance = require('../../services/variance.service');

describe('variance.service — actualsByLine', () => {
  beforeEach(() => jest.clearAllMocks());
  test('returns a map keyed accountId|costCenterId with debit/credit sums', async () => {
    mockAggregate.mockResolvedValue([
      { _id: { accountId: 'a1', cc: null }, debit: 130000, credit: 0 },
      { _id: { accountId: 'rev', cc: null }, debit: 0, credit: 540000 },
    ]);
    const map = await variance.actualsByLine('biz1', { from: new Date('2026-07-01'), to: new Date('2026-07-31') });
    expect(map['a1|']).toEqual({ debit: 130000, credit: 0 });
    expect(map['rev|']).toEqual({ debit: 0, credit: 540000 });
  });
});
```

- [ ] **Step 3: Run to verify it fails.**

Run: `npx jest __tests__/services/variance.service.test.js -v`
Expected: FAIL — cannot find `variance.service`.

- [ ] **Step 4: Implement `actualsByLine` + `actualsByMonth`.**

```js
// services/variance.service.js — FR-04.2
'use strict';
const mongoose = require('mongoose');
const JournalEntry = require('../models/JournalEntry.model');
const { EFFECTIVE_LINES_STAGE, REPORT_STATUSES } = require('../repositories/transaction.repository');

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const key = (accountId, cc) => `${String(accountId)}|${cc ? String(cc) : ''}`;

function _matchStage(businessId, from, to) {
  return {
    $match: {
      businessId: oid(businessId),
      transactionDate: { $gte: new Date(from), $lte: new Date(to) },
      status: { $in: REPORT_STATUSES },
      isArchived: { $ne: true },
    },
  };
}

// Carry a per-line cost centre: prefer the journalLines cost centre, else the
// entry-level costCenterId (synthesised pairs have no per-line cost centre).
const ADD_LINE_CC = {
  $addFields: { 'effectiveLines.cc': { $ifNull: ['$effectiveLines.costCenterId', '$costCenterId'] } },
};

/** Debit/credit sums per account+cost-centre over [from,to]. */
async function actualsByLine(businessId, { from, to }) {
  const rows = await JournalEntry.aggregate([
    _matchStage(businessId, from, to),
    EFFECTIVE_LINES_STAGE,
    { $unwind: '$effectiveLines' },
    ADD_LINE_CC,
    {
      $group: {
        _id: { accountId: '$effectiveLines.accountId', cc: '$effectiveLines.cc' },
        debit:  { $sum: { $cond: [{ $eq: ['$effectiveLines.type', 'debit'] },  '$effectiveLines.amount', 0] } },
        credit: { $sum: { $cond: [{ $eq: ['$effectiveLines.type', 'credit'] }, '$effectiveLines.amount', 0] } },
      },
    },
  ]);
  const map = {};
  for (const r of rows) map[key(r._id.accountId, r._id.cc)] = { debit: r.debit, credit: r.credit };
  return map;
}

/** Per-account 12-month net actuals for [from,to] — used to seed a budget from
 *  the prior year. Net is signed by natural direction is applied later; here we
 *  return the raw monthly debit−credit so seeding is sign-agnostic positive. */
async function actualsByMonth(businessId, { from, to }) {
  const start = new Date(from);
  const rows = await JournalEntry.aggregate([
    _matchStage(businessId, from, to),
    EFFECTIVE_LINES_STAGE,
    { $unwind: '$effectiveLines' },
    ADD_LINE_CC,
    {
      $addFields: {
        _monthIdx: {
          $add: [
            { $multiply: [{ $subtract: [{ $year: '$transactionDate' }, start.getUTCFullYear()] }, 12] },
            { $subtract: [{ $month: '$transactionDate' }, start.getUTCMonth() + 1] },
          ],
        },
        _signed: {
          $cond: [{ $eq: ['$effectiveLines.type', 'debit'] }, '$effectiveLines.amount', { $multiply: ['$effectiveLines.amount', -1] }],
        },
      },
    },
    {
      $group: {
        _id: { accountId: '$effectiveLines.accountId', cc: '$effectiveLines.cc', m: '$_monthIdx' },
        net: { $sum: '$_signed' },
      },
    },
  ]);
  const byAccount = {};
  for (const r of rows) {
    const k = key(r._id.accountId, r._id.cc);
    if (!byAccount[k]) byAccount[k] = { accountId: String(r._id.accountId), costCenterId: r._id.cc ? String(r._id.cc) : null, monthly: Array(12).fill(0) };
    const idx = r._id.m;
    if (idx >= 0 && idx < 12) byAccount[k].monthly[idx] += Math.abs(r.net);
  }
  return Object.values(byAccount);
}

module.exports = { actualsByLine, actualsByMonth, key };
```

- [ ] **Step 5: Run to verify it passes.**

Run: `npx jest __tests__/services/variance.service.test.js -v`
Expected: PASS

- [ ] **Step 6: Commit.**

```bash
git add services/variance.service.js repositories/transaction.repository.js __tests__/services/variance.service.test.js
git commit -m "feat(variance): GL actuals aggregation (base currency, per account+cost-centre)"
```

---

## Task 8: variance.service — computeVariance (sign, favorability, RAG)

**Files:**
- Modify: `services/variance.service.js`
- Modify: `__tests__/services/variance.service.test.js`

- [ ] **Step 1: Add failing tests.**

```js
jest.mock('../../repositories/budget.repository', () => ({ findOwnedById: jest.fn() }));
jest.mock('../../repositories/fiscalYear.repository', () => ({ findOwnedById: jest.fn() }));
jest.mock('../../repositories/account.repository', () => ({ findByBusiness: jest.fn() }));

const budgetRepo = require('../../repositories/budget.repository');
const fyRepo = require('../../repositories/fiscalYear.repository');
const accountRepo = require('../../repositories/account.repository');

describe('variance.service — computeVariance', () => {
  beforeEach(() => jest.clearAllMocks());

  function setup(lines, actuals, accounts) {
    budgetRepo.findOwnedById.mockResolvedValue({
      _id: 'b1', fiscalYearId: 'fy1', scenario: 'base', defaultThresholdPct: 10, lines,
    });
    fyRepo.findOwnedById.mockResolvedValue({ _id: 'fy1', startDate: new Date('2026-07-01'), endDate: new Date('2027-06-30') });
    accountRepo.findByBusiness.mockResolvedValue(accounts);
    jest.spyOn(variance, 'actualsByLine').mockResolvedValue(actuals);
  }

  test('expense over budget → unfavorable red, variance = actual − budget', async () => {
    setup(
      [{ accountId: 'a1', costCenterId: null, monthly: [100000, 0,0,0,0,0,0,0,0,0,0,0], thresholdPct: null }],
      { 'a1|': { debit: 130000, credit: 0 } },
      [{ _id: 'a1', accountName: 'Rent', accountType: 'Expense' }],
    );
    const r = await variance.computeVariance('biz1', 'b1', { asOf: new Date('2026-07-31') });
    const line = r.lines[0];
    expect(line.actual).toBe(130000);
    expect(line.budget).toBe(100000);
    expect(line.variance).toBe(30000);
    expect(line.favorable).toBe(false);
    expect(line.rag).toBe('red');
  });

  test('revenue above budget → favorable green (reversed sign)', async () => {
    setup(
      [{ accountId: 'rev', costCenterId: null, monthly: [500000,0,0,0,0,0,0,0,0,0,0,0], thresholdPct: null }],
      { 'rev|': { debit: 0, credit: 540000 } },
      [{ _id: 'rev', accountName: 'Sales', accountType: 'Revenue' }],
    );
    const r = await variance.computeVariance('biz1', 'b1', { asOf: new Date('2026-07-31') });
    expect(r.lines[0].actual).toBe(540000);
    expect(r.lines[0].favorable).toBe(true);
    expect(r.lines[0].rag).toBe('green');
  });

  test('budget=0 guard → variancePct null', async () => {
    setup(
      [{ accountId: 'a1', costCenterId: null, monthly: Array(12).fill(0), thresholdPct: null }],
      { 'a1|': { debit: 5000, credit: 0 } },
      [{ _id: 'a1', accountName: 'Misc', accountType: 'Expense' }],
    );
    const r = await variance.computeVariance('biz1', 'b1', { asOf: new Date('2026-07-31') });
    expect(r.lines[0].variancePct).toBeNull();
  });

  test('YTD window sums only elapsed months', async () => {
    setup(
      [{ accountId: 'a1', costCenterId: null, monthly: [100,100,100,100,100,100,100,100,100,100,100,100], thresholdPct: null }],
      { 'a1|': { debit: 250, credit: 0 } },
      [{ _id: 'a1', accountName: 'Rent', accountType: 'Expense' }],
    );
    // asOf in fiscal month 3 (Sept for a July-start year) → budget = 300
    const r = await variance.computeVariance('biz1', 'b1', { asOf: new Date('2026-09-15') });
    expect(r.lines[0].budget).toBe(300);
  });
});
```

- [ ] **Step 2: Run to verify they fail.**

Run: `npx jest __tests__/services/variance.service.test.js -t computeVariance -v`
Expected: FAIL — `variance.computeVariance is not a function`.

- [ ] **Step 3: Implement `computeVariance` + helpers.** Add requires and functions in `variance.service.js`:

```js
const budgetRepo = require('../repositories/budget.repository');
const fyRepo = require('../repositories/fiscalYear.repository');
const accountRepo = require('../repositories/account.repository');
const { ApiError } = require('../utils/ApiError');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Fiscal months elapsed from year start to asOf, clamped 1..12. */
function monthsElapsed(fyStart, asOf) {
  const s = new Date(fyStart), a = new Date(asOf);
  const m = (a.getUTCFullYear() - s.getUTCFullYear()) * 12 + (a.getUTCMonth() - s.getUTCMonth()) + 1;
  return Math.max(1, Math.min(12, m));
}

function ragFor(favorable, pct, thresholdPct) {
  if (favorable) return 'green';
  const t = (Number(thresholdPct) || 0) / 100;
  const abs = pct == null ? 0 : Math.abs(pct);
  if (abs <= t) return 'green';
  if (abs <= 2 * t) return 'amber';
  return 'red';
}

async function computeVariance(businessId, budgetId, { asOf } = {}) {
  const budget = await budgetRepo.findOwnedById(businessId, budgetId);
  if (!budget) throw new ApiError(404, 'Budget not found.');
  const fy = await fyRepo.findOwnedById(businessId, budget.fiscalYearId);
  if (!fy) throw new ApiError(404, 'Fiscal year not found.');

  const at = asOf ? new Date(asOf) : new Date();
  const windowEnd = at > new Date(fy.endDate) ? new Date(fy.endDate) : at;
  const elapsed = monthsElapsed(fy.startDate, windowEnd);

  const [actuals, accounts] = await Promise.all([
    this.actualsByLine(businessId, { from: fy.startDate, to: windowEnd }),
    accountRepo.findByBusiness(businessId),
  ]);
  const typeById = new Map((accounts || []).map((a) => [String(a._id), a.accountType]));
  const nameById = new Map((accounts || []).map((a) => [String(a._id), a.accountName]));

  const lines = (budget.lines || []).map((l) => {
    const k = key(l.accountId, l.costCenterId);
    const dc = actuals[k] || { debit: 0, credit: 0 };
    const type = typeById.get(String(l.accountId)) || 'Expense';
    const isRevenue = type === 'Revenue';
    const actual = round2(isRevenue ? dc.credit - dc.debit : dc.debit - dc.credit);
    const budgetAmt = round2((l.monthly || []).slice(0, elapsed).reduce((s, m) => s + (Number(m) || 0), 0));
    const v = round2(actual - budgetAmt);
    const variancePct = budgetAmt === 0 ? null : round2(v / Math.abs(budgetAmt));
    const favorable = isRevenue ? actual >= budgetAmt : actual <= budgetAmt;
    const threshold = l.thresholdPct != null ? l.thresholdPct : budget.defaultThresholdPct;
    return {
      accountId: String(l.accountId),
      accountName: nameById.get(String(l.accountId)) || '',
      accountType: type,
      costCenterId: l.costCenterId ? String(l.costCenterId) : null,
      budget: budgetAmt, actual, variance: v, variancePct, favorable,
      rag: ragFor(favorable, variancePct, threshold),
      drillFilter: { accountId: String(l.accountId), costCenterId: l.costCenterId ? String(l.costCenterId) : null,
                     from: fy.startDate, to: windowEnd },
    };
  });

  return {
    budgetId: String(budget._id), scenario: budget.scenario,
    fiscalYearId: String(budget.fiscalYearId), asOf: windowEnd, monthsElapsed: elapsed, lines,
    totals: {
      budget: round2(lines.reduce((s, l) => s + l.budget, 0)),
      actual: round2(lines.reduce((s, l) => s + l.actual, 0)),
      variance: round2(lines.reduce((s, l) => s + l.variance, 0)),
    },
  };
}
```

Add `computeVariance, ragFor, monthsElapsed` to `module.exports`.

> The tests `jest.spyOn(variance, 'actualsByLine')` — so `computeVariance` calls `this.actualsByLine(...)`. Export the module object and reference `this`; because `module.exports` is the object the test spies on, calling `this.actualsByLine` resolves to the spy. Ensure `computeVariance` is defined as a normal function and added to the exported object (so `this` binds to it when called as `variance.computeVariance`).

- [ ] **Step 4: Run to verify they pass.**

Run: `npx jest __tests__/services/variance.service.test.js -v`
Expected: PASS (all variance tests)

- [ ] **Step 5: Commit.**

```bash
git add services/variance.service.js __tests__/services/variance.service.test.js
git commit -m "feat(variance): computeVariance with revenue sign-flip + RAG banding"
```

---

## Task 9: variance.service — checkBreaches (alert firing + dedup)

**Files:**
- Modify: `services/variance.service.js`
- Test: `__tests__/services/budgetVariance.subscriber.test.js`

- [ ] **Step 1: Write the failing test.**

```js
// __tests__/services/budgetVariance.subscriber.test.js
'use strict';
jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../models/JournalEntry.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../repositories/transaction.repository', () => ({ EFFECTIVE_LINES_STAGE: {}, REPORT_STATUSES: [] }));
jest.mock('../../repositories/budget.repository', () => ({ findActiveByFiscalYear: jest.fn(), findOwnedById: jest.fn() }));
jest.mock('../../repositories/fiscalYear.repository', () => ({ findOwnedById: jest.fn(), findContaining: jest.fn() }));
jest.mock('../../repositories/account.repository', () => ({ findByBusiness: jest.fn() }));

const FinancialAlert = require('../../models/FinancialAlert.model');
jest.mock('../../models/FinancialAlert.model', () => ({ updateOne: jest.fn().mockResolvedValue({ upsertedCount: 1 }) }));

const fyRepo = require('../../repositories/fiscalYear.repository');
const budgetRepo = require('../../repositories/budget.repository');
const variance = require('../../services/variance.service');

describe('variance.checkBreaches', () => {
  beforeEach(() => jest.clearAllMocks());

  test('fires a deduped FinancialAlert for a red line among affected accounts', async () => {
    fyRepo.findContaining.mockResolvedValue({ _id: 'fy1', startDate: new Date('2026-07-01'), endDate: new Date('2027-06-30') });
    budgetRepo.findActiveByFiscalYear.mockResolvedValue([{ _id: 'b1', fiscalYearId: 'fy1' }]);
    jest.spyOn(variance, 'computeVariance').mockResolvedValue({
      budgetId: 'b1',
      lines: [
        { accountId: 'a1', accountName: 'Rent', rag: 'red', favorable: false, budget: 100, actual: 200, variance: 100, variancePct: 1, costCenterId: null },
        { accountId: 'a2', accountName: 'Misc', rag: 'green', favorable: true, costCenterId: null },
      ],
    });
    await variance.checkBreaches('biz1', ['a1'], { entryDate: new Date('2026-07-15') });
    expect(FinancialAlert.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, opts] = FinancialAlert.updateOne.mock.calls[0];
    expect(filter.ruleKey).toMatch(/^budget_variance:b1:a1:/);
    expect(opts.upsert).toBe(true);
    expect(update.$setOnInsert.level).toBe('critical');
  });

  test('no alert when no affected account breaches', async () => {
    fyRepo.findContaining.mockResolvedValue({ _id: 'fy1', startDate: new Date('2026-07-01'), endDate: new Date('2027-06-30') });
    budgetRepo.findActiveByFiscalYear.mockResolvedValue([{ _id: 'b1', fiscalYearId: 'fy1' }]);
    jest.spyOn(variance, 'computeVariance').mockResolvedValue({
      budgetId: 'b1', lines: [{ accountId: 'a1', rag: 'green', favorable: true, costCenterId: null }],
    });
    await variance.checkBreaches('biz1', ['a1'], { entryDate: new Date('2026-07-15') });
    expect(FinancialAlert.updateOne).not.toHaveBeenCalled();
  });

  test('no budget covering the entry date → silent', async () => {
    fyRepo.findContaining.mockResolvedValue(null);
    await variance.checkBreaches('biz1', ['a1'], { entryDate: new Date('2020-01-01') });
    expect(FinancialAlert.updateOne).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx jest __tests__/services/budgetVariance.subscriber.test.js -v`
Expected: FAIL — `variance.checkBreaches is not a function` (and `findContaining` missing).

- [ ] **Step 3: Add `findContaining` to the fiscal-year repo** (`repositories/fiscalYear.repository.js`):

```js
  /** The fiscal year whose [startDate,endDate] contains the given date. */
  findContaining(businessId, date) {
    const d = new Date(date);
    return this.model.findOne({ businessId, startDate: { $lte: d }, endDate: { $gte: d } }).lean();
  }
```

- [ ] **Step 4: Implement `checkBreaches` in `variance.service.js`.**

```js
const FinancialAlert = require('../models/FinancialAlert.model');

const RAG_LEVEL = { red: 'critical', amber: 'warning' };

function _periodKey(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Recompute affected lines of every active budget covering the entry date and
 *  upsert a deduped FinancialAlert for each breaching (red, default) line. */
async function checkBreaches(businessId, affectedAccountIds, { entryDate, alertOn = ['red'] } = {}) {
  const when = entryDate ? new Date(entryDate) : new Date();
  const fy = await fyRepo.findContaining(businessId, when);
  if (!fy) return;
  const budgets = await budgetRepo.findActiveByFiscalYear(businessId, fy._id);
  if (!budgets || budgets.length === 0) return;

  const affected = new Set((affectedAccountIds || []).map(String));
  const periodKey = _periodKey(when);

  for (const b of budgets) {
    const result = await this.computeVariance(businessId, b._id, { asOf: when });
    const breaches = result.lines.filter(
      (l) => affected.has(String(l.accountId)) && alertOn.includes(l.rag));
    for (const l of breaches) {
      const ccPart = l.costCenterId ? String(l.costCenterId) : '-';
      const ruleKey = `budget_variance:${result.budgetId}:${l.accountId}:${ccPart}`;
      await FinancialAlert.updateOne(
        { businessId, ruleKey, periodKey },
        {
          $setOnInsert: {
            businessId, ruleKey, periodKey,
            level: RAG_LEVEL[l.rag] || 'warning',
            title: `${l.accountName || 'An account'} is over budget`,
            what: `${l.accountName || 'An account'} spending is past its plan`,
            howMuch: `Actual ${l.actual} vs plan ${l.budget} (${l.variancePct != null ? Math.round(l.variancePct * 100) : '—'}% over)`,
            sinceWhen: periodKey,
            recommendation: 'Review this account on the Budget vs Actual page.',
            actionTo: '/budgets/variance',
            data: { budgetId: result.budgetId, accountId: l.accountId, costCenterId: l.costCenterId,
                    budget: l.budget, actual: l.actual, variance: l.variance, variancePct: l.variancePct },
            status: 'open', firedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
  }
}
```

Add `checkBreaches` to `module.exports`.

- [ ] **Step 5: Run to verify it passes.**

Run: `npx jest __tests__/services/budgetVariance.subscriber.test.js -v`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit.**

```bash
git add services/variance.service.js repositories/fiscalYear.repository.js __tests__/services/budgetVariance.subscriber.test.js
git commit -m "feat(variance): checkBreaches fires deduped budget-variance alerts"
```

---

## Task 10: Event subscriber wiring

**Files:**
- Modify: `services/eventSubscribers.service.js`
- Test: `__tests__/services/eventSubscribers.budget.test.js`

- [ ] **Step 1: Write the failing test.**

```js
// __tests__/services/eventSubscribers.budget.test.js
'use strict';
jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../utils/reportCache', () => ({ invalidate: jest.fn() }));
jest.mock('../../services/variance.service', () => ({ checkBreaches: jest.fn().mockResolvedValue() }));

const { businessEvents, EVENTS } = require('../../services/businessEventEngine.service');
const subscribers = require('../../services/eventSubscribers.service');
const variance = require('../../services/variance.service');

describe('eventSubscribers — budget variance', () => {
  test('transaction.created triggers variance.checkBreaches with affected accounts', async () => {
    subscribers._resetForTest();
    subscribers.registerAll();
    businessEvents.emit(EVENTS.TRANSACTION_CREATED, {
      businessId: 'biz1',
      after: {
        transactionDate: new Date('2026-07-15'),
        debitAccountId: 'a1', creditAccountId: 'a2',
        journalLines: [{ accountId: 'a1', type: 'debit', amount: 100 }, { accountId: 'a2', type: 'credit', amount: 100 }],
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(variance.checkBreaches).toHaveBeenCalledWith('biz1',
      expect.arrayContaining(['a1', 'a2']), expect.objectContaining({ entryDate: expect.anything() }));
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx jest __tests__/services/eventSubscribers.budget.test.js -v`
Expected: FAIL — `checkBreaches` not called.

- [ ] **Step 3: Wire the subscriber** inside `registerAll()` in `services/eventSubscribers.service.js`, after the durable-event-log writer block and before the closing `logger.info(...)`:

```js
  // ── Budgeting FR-04.2 — real-time variance breach alerts ──────────────────
  // Any GL movement may push an account past its budget threshold. Recompute the
  // affected lines of the active budget(s) and fire a deduped alert (≤60s SRS).
  // Fire-and-forget + error-isolated: a variance failure can never unwind a post.
  const budgetVarianceHandler = async (evt) => {
    if (!evt || !evt.businessId) return;
    const entry = evt.after || {};
    const ids = new Set();
    if (Array.isArray(entry.journalLines) && entry.journalLines.length) {
      for (const l of entry.journalLines) if (l.accountId) ids.add(String(l.accountId));
    } else {
      if (entry.debitAccountId) ids.add(String(entry.debitAccountId));
      if (entry.creditAccountId) ids.add(String(entry.creditAccountId));
    }
    if (ids.size === 0) return;
    const variance = require('./variance.service');
    await variance.checkBreaches(String(evt.businessId), [...ids], {
      entryDate: entry.transactionDate || new Date(),
    });
  };
  businessEvents.on(EVENTS.TRANSACTION_CREATED, budgetVarianceHandler, { name: 'budget-variance-check' });
  businessEvents.on(EVENTS.TRANSACTION_REVERSED, budgetVarianceHandler, { name: 'budget-variance-check:reversed' });
```

- [ ] **Step 4: Run to verify it passes.**

Run: `npx jest __tests__/services/eventSubscribers.budget.test.js -v`
Expected: PASS

- [ ] **Step 5: Commit.**

```bash
git add services/eventSubscribers.service.js __tests__/services/eventSubscribers.budget.test.js
git commit -m "feat(budget): wire transaction.created/reversed → variance.checkBreaches"
```

---

## Task 11: Validation + controller + routes + mount

**Files:**
- Create: `validations/budget.validation.js`
- Create: `controllers/budget.controller.js`
- Create: `routes/v1/budget.routes.js`
- Modify: `routes/index.js`
- Test: `__tests__/controllers/budget.controller.test.js`

- [ ] **Step 1: Write the validation schemas.** Mirror `validations/payroll.validation.js` (Joi). Inspect that file first for the exact Joi import style, then create:

```js
// validations/budget.validation.js — FR-04.1
'use strict';
const Joi = require('joi');

const objectId = Joi.string().hex().length(24);

const lineSchema = Joi.object({
  accountId: objectId.required(),
  costCenterId: objectId.allow(null, ''),
  monthly: Joi.array().items(Joi.number()).length(12).required(),
  thresholdPct: Joi.number().min(0).allow(null),
});

const createBudgetSchema = Joi.object({
  name: Joi.string().max(120).required(),
  fiscalYearId: objectId.required(),
  scenario: Joi.string().valid('base', 'optimistic', 'pessimistic').default('base'),
  defaultThresholdPct: Joi.number().min(0).default(10),
  lines: Joi.array().items(lineSchema).default([]),
});

const updateBudgetSchema = Joi.object({
  name: Joi.string().max(120),
  defaultThresholdPct: Joi.number().min(0),
  lines: Joi.array().items(lineSchema),
}).min(1);

const seedSchema = Joi.object({
  fiscalYearId: objectId.required(),
  scenario: Joi.string().valid('base', 'optimistic', 'pessimistic').default('base'),
});

const approvalNoteSchema = Joi.object({ note: Joi.string().allow('', null) });

module.exports = { createBudgetSchema, updateBudgetSchema, seedSchema, approvalNoteSchema };
```

- [ ] **Step 2: Write the controller** (mirror `controllers/payroll.controller.js` `biz`/`actor` helpers):

```js
// controllers/budget.controller.js — FR-04.1 / FR-04.2
'use strict';
const ApiResponse = require('../utils/ApiResponse');
const budget = require('../services/budget.service');
const variance = require('../services/variance.service');

const biz = (req) => req.user.businessId;
const actor = (req) => ({ _id: req.user.id, id: req.user.id, role: req.user.role,
  fullName: req.user.fullName, email: req.user.email, approvalLevels: req.user.approvalLevels });

exports.list = async (req, res, next) => {
  try {
    return ApiResponse.success(res, await budget.list(biz(req), {
      fiscalYearId: req.query.fiscalYearId, scenario: req.query.scenario, status: req.query.status }));
  } catch (e) { next(e); }
};
exports.getOne = async (req, res, next) => {
  try { return ApiResponse.success(res, await budget.getById(biz(req), req.params.id)); } catch (e) { next(e); }
};
exports.create = async (req, res, next) => {
  try { return ApiResponse.created(res, await budget.createDraft(biz(req), req.body, actor(req)), 'Budget created.'); }
  catch (e) { next(e); }
};
exports.update = async (req, res, next) => {
  try { return ApiResponse.success(res, await budget.updateDraft(biz(req), req.params.id, req.body, actor(req)), 'Budget saved.'); }
  catch (e) { next(e); }
};
exports.seed = async (req, res, next) => {
  try { return ApiResponse.success(res, await budget.seedFromActuals(biz(req), req.body.fiscalYearId, { scenario: req.body.scenario })); }
  catch (e) { next(e); }
};
exports.submit = async (req, res, next) => {
  try { return ApiResponse.success(res, await budget.submitForApproval(biz(req), req.params.id, actor(req)), 'Budget submitted for approval.'); }
  catch (e) { next(e); }
};
exports.approve = async (req, res, next) => {
  try { return ApiResponse.success(res, await budget.approve(biz(req), req.params.id, actor(req), req.body.note), 'Budget approved.'); }
  catch (e) { next(e); }
};
exports.reject = async (req, res, next) => {
  try { return ApiResponse.success(res, await budget.reject(biz(req), req.params.id, actor(req), req.body.note), 'Budget rejected.'); }
  catch (e) { next(e); }
};
exports.clone = async (req, res, next) => {
  try { return ApiResponse.created(res, await budget.cloneVersion(biz(req), req.params.id, actor(req)), 'New draft version created.'); }
  catch (e) { next(e); }
};
exports.variance = async (req, res, next) => {
  try { return ApiResponse.success(res, await variance.computeVariance(biz(req), req.params.id, { asOf: req.query.asOf })); }
  catch (e) { next(e); }
};
```

- [ ] **Step 3: Write the routes** (mirror `routes/v1/payroll.routes.js`):

```js
// routes/v1/budget.routes.js — FR-04.1 / FR-04.2
'use strict';
const express = require('express');
const ctrl = require('../../controllers/budget.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate = require('../../middleware/validate.middleware');
const { createBudgetSchema, updateBudgetSchema, seedSchema, approvalNoteSchema } = require('../../validations/budget.validation');

const router = express.Router();
router.use(authMiddleware);
router.use(requireBusiness);

router.get('/', ctrl.list);
router.post('/', validate(createBudgetSchema), ctrl.create);
router.post('/seed', validate(seedSchema), ctrl.seed);
router.get('/:id', ctrl.getOne);
router.put('/:id', validate(updateBudgetSchema), ctrl.update);
router.post('/:id/submit', ctrl.submit);
router.post('/:id/approve', validate(approvalNoteSchema), ctrl.approve);
router.post('/:id/reject', validate(approvalNoteSchema), ctrl.reject);
router.post('/:id/clone', ctrl.clone);
router.get('/:id/variance', ctrl.variance);

module.exports = router;
```

- [ ] **Step 4: Mount in `routes/index.js`.** Find the payroll mount line (`router.use('/payroll', ...)`), add a `budgetRoutes` require near the other route requires, and add:

```js
router.use('/budgets', require('./v1/budget.routes'));
```

(Use whichever require/mount style the file already uses — match the payroll line exactly.)

- [ ] **Step 5: Write a controller smoke test.**

```js
// __tests__/controllers/budget.controller.test.js
'use strict';
jest.mock('../../services/budget.service');
jest.mock('../../services/variance.service');
const budget = require('../../services/budget.service');
const ctrl = require('../../controllers/budget.controller');

const mkRes = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };
const req = (over = {}) => ({ user: { businessId: 'biz1', id: 'u1', role: 'owner' }, params: {}, query: {}, body: {}, ...over });

describe('budget.controller', () => {
  beforeEach(() => jest.clearAllMocks());
  test('create delegates to createDraft and returns 201', async () => {
    budget.createDraft.mockResolvedValue({ _id: 'b1' });
    const res = mkRes();
    await ctrl.create(req({ body: { name: 'X' } }), res, jest.fn());
    expect(budget.createDraft).toHaveBeenCalledWith('biz1', { name: 'X' }, expect.objectContaining({ id: 'u1' }));
    expect(res.status).toHaveBeenCalledWith(201);
  });
  test('list passes query filters', async () => {
    budget.list.mockResolvedValue([]);
    const res = mkRes();
    await ctrl.list(req({ query: { scenario: 'base' } }), res, jest.fn());
    expect(budget.list).toHaveBeenCalledWith('biz1', expect.objectContaining({ scenario: 'base' }));
  });
});
```

- [ ] **Step 6: Run controller test + verify route file loads.**

Run: `npx jest __tests__/controllers/budget.controller.test.js -v && node -e "require('./routes/v1/budget.routes'); console.log('route ok')"`
Expected: PASS + `route ok`

- [ ] **Step 7: Commit.**

```bash
git add validations/budget.validation.js controllers/budget.controller.js routes/v1/budget.routes.js routes/index.js __tests__/controllers/budget.controller.test.js
git commit -m "feat(budget): validation + controller + routes, mount /budgets"
```

---

## Task 12: Integration smoke (full suite gate)

**Files:**
- Create: `tests/integration/budget.flow.test.js`

This is a service-level integration test with mocked models — it proves the lifecycle wires together (create → submit → approve → variance → breach alert) without a live DB.

- [ ] **Step 1: Write the test.**

```js
// tests/integration/budget.flow.test.js
'use strict';
jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../repositories/budget.repository');
jest.mock('../../repositories/fiscalYear.repository');
jest.mock('../../repositories/account.repository');
jest.mock('../../services/costCenter.service', () => ({ validateAssignable: jest.fn().mockResolvedValue(null) }));
jest.mock('../../services/approvalEngine.service', () => ({
  buildChain: jest.fn(() => [{ sequence: 1, level: 'FINANCE', status: 'pending' }]),
  approveStep: jest.fn((doc) => { doc.approvalChain[0].status = 'approved'; return { fullyApproved: true }; }),
}));

const budgetRepo = require('../../repositories/budget.repository');
const fyRepo = require('../../repositories/fiscalYear.repository');
const accountRepo = require('../../repositories/account.repository');
const budget = require('../../services/budget.service');
const variance = require('../../services/variance.service');

describe('budget flow (service integration)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('create → submit → approve → variance reflects GL actuals', async () => {
    // create
    budgetRepo.create.mockResolvedValue({ _id: 'b1', status: 'draft', version: 1,
      lines: [{ accountId: 'rent', monthly: [100000, ...Array(11).fill(0)] }] });
    const draft = await budget.createDraft('biz1',
      { name: 'FY26', fiscalYearId: 'fy1', scenario: 'base',
        lines: [{ accountId: 'rent', monthly: [100000, ...Array(11).fill(0)] }] }, { id: 'u1' });
    expect(draft.status).toBe('draft');

    // submit
    budgetRepo.findOwnedById.mockResolvedValue({ _id: 'b1', status: 'draft', lines: draft.lines });
    budgetRepo.update.mockImplementation((id, u) => Promise.resolve({ _id: id, ...u }));
    const submitted = await budget.submitForApproval('biz1', 'b1', { id: 'u1' });
    expect(submitted.status).toBe('pending_approval');

    // approve
    budgetRepo.findOwnedById.mockResolvedValue({ _id: 'b1', status: 'pending_approval',
      approvalChain: [{ status: 'pending' }], fiscalYearId: 'fy1', scenario: 'base', createdBy: 'creator' });
    budgetRepo.findActive.mockResolvedValue(null);
    const approved = await budget.approve('biz1', 'b1', { _id: 'approver', id: 'approver' }, 'ok');
    expect(approved.status).toBe('active');

    // variance
    budgetRepo.findOwnedById.mockResolvedValue({ _id: 'b1', fiscalYearId: 'fy1', scenario: 'base',
      defaultThresholdPct: 10, lines: [{ accountId: 'rent', costCenterId: null, monthly: [100000, ...Array(11).fill(0)], thresholdPct: null }] });
    fyRepo.findOwnedById.mockResolvedValue({ _id: 'fy1', startDate: new Date('2026-07-01'), endDate: new Date('2027-06-30') });
    accountRepo.findByBusiness.mockResolvedValue([{ _id: 'rent', accountName: 'Rent', accountType: 'Expense' }]);
    jest.spyOn(variance, 'actualsByLine').mockResolvedValue({ 'rent|': { debit: 130000, credit: 0 } });
    const v = await variance.computeVariance('biz1', 'b1', { asOf: new Date('2026-07-31') });
    expect(v.lines[0].variance).toBe(30000);
    expect(v.lines[0].rag).toBe('red');
  });
});
```

- [ ] **Step 2: Run the integration test.**

Run: `npx jest tests/integration/budget.flow.test.js -v`
Expected: PASS

- [ ] **Step 3: Run the FULL backend suite (contamination gate).**

Run: `npm test`
Expected: all suites green (prior baseline was 137 suites / 1102 tests; this adds ~6 suites). No pre-existing test broken.

- [ ] **Step 4: Commit.**

```bash
git add tests/integration/budget.flow.test.js
git commit -m "test(budget): service-integration flow create→submit→approve→variance"
```

- [ ] **Step 5: Push the backend** (protect the work — OneDrive ref corruption risk):

```bash
git push origin main
```

---

## Task 13: Frontend — service + pages + nav + routes

**Files:**
- Create: `src/services/budget.service.js`
- Create: `src/pages/budget/BudgetEditorPage.jsx`
- Create: `src/pages/budget/VarianceDashboardPage.jsx`
- Modify: `src/config/nav.config.js`
- Modify: `src/routes.jsx`

Work in `vousfin-frontend-main/`. First read `src/services/payroll.service.js`, an existing page (e.g. `src/pages/payroll/PayrollRunPage.jsx`), `src/config/nav.config.js`, and `src/routes.jsx` to copy conventions exactly (api instance import, `getErrorMessage`, `withSuspense`, TanStack Query usage, accent classes).

- [ ] **Step 1: API service.**

```js
// src/services/budget.service.js
import api from './api';

export const budgetApi = {
  list:    (params) => api.get('/budgets', { params }).then((r) => r.data.data),
  get:     (id) => api.get(`/budgets/${id}`).then((r) => r.data.data),
  create:  (body) => api.post('/budgets', body).then((r) => r.data.data),
  update:  (id, body) => api.put(`/budgets/${id}`, body).then((r) => r.data.data),
  seed:    (body) => api.post('/budgets/seed', body).then((r) => r.data.data),
  submit:  (id) => api.post(`/budgets/${id}/submit`).then((r) => r.data.data),
  approve: (id, note) => api.post(`/budgets/${id}/approve`, { note }).then((r) => r.data.data),
  reject:  (id, note) => api.post(`/budgets/${id}/reject`, { note }).then((r) => r.data.data),
  clone:   (id) => api.post(`/budgets/${id}/clone`).then((r) => r.data.data),
  variance:(id, asOf) => api.get(`/budgets/${id}/variance`, { params: { asOf } }).then((r) => r.data.data),
};
```

- [ ] **Step 2: BudgetEditorPage.jsx.** Build a page that:
  - Loads fiscal years (reuse existing fiscal-year query/service if present; otherwise `api.get('/fiscal-years')` — verify the actual route by grepping the codebase) and accounts (`api.get('/business/accounts')`).
  - Lets the user pick fiscal year + scenario (base/optimistic/pessimistic) + name.
  - Renders an account × 12-month grid grouped by `accountType`, editable cells.
  - Toolbar buttons: **"Seed from last year"** (calls `budgetApi.seed`, loads `lines` into the grid), **"Annual → split"** per row (input an annual figure → fills 12 months evenly client-side, mirroring `splitEvenly`), **Save draft** (`create`/`update`), **Submit for approval** (`submit`).
  - Uses plain-language labels: section title "Budget / Plan", revenue rows under "Expected income", expense rows under "Expected spending". Use `getErrorMessage` for all `toast.error`.
  - Client-side `splitEvenly` helper to mirror the backend (per = round2(annual/12), last cell absorbs remainder).

- [ ] **Step 3: VarianceDashboardPage.jsx.** Build a page that:
  - Picks a budget (list filtered to `status=active`, with scenario switcher).
  - Calls `budgetApi.variance(id, asOf)` and renders a table per line: account name, cost-centre, **Budget**, **Actual**, **Variance**, **%**, colour-coded by `rag` (green/amber/red) and a Favorable/Unfavorable badge.
  - Each row links to the Transactions page filtered by `drillFilter` (`accountId` + date range) — match the existing transactions route's query-param contract (grep `pages/transactions` for the param names).
  - Shows totals row.

- [ ] **Step 4: Nav.** In `src/config/nav.config.js`, add a **"Budgets"** section (pick an unused accent, mirror the payroll section's shape) with items:
  - `{ label: 'Budget Editor', to: '/budgets/editor' }`
  - `{ label: 'Budget vs Actual', to: '/budgets/variance' }`

- [ ] **Step 5: Routes.** In `src/routes.jsx`, add lazy imports + routes wrapped in `withSuspense()` (mirror payroll route entries):

```jsx
const BudgetEditorPage = lazy(() => import('./pages/budget/BudgetEditorPage'));
const VarianceDashboardPage = lazy(() => import('./pages/budget/VarianceDashboardPage'));
// inside the RequireBusiness children:
{ path: 'budgets/editor', element: withSuspense(BudgetEditorPage) },
{ path: 'budgets/variance', element: withSuspense(VarianceDashboardPage) },
```

- [ ] **Step 6: Build + lint.**

Run (in `vousfin-frontend-main/`): `npm run build && npm run lint`
Expected: build succeeds; lint clean on the new files.

- [ ] **Step 7: Commit + push.**

```bash
git add src/services/budget.service.js src/pages/budget src/config/nav.config.js src/routes.jsx
git commit -m "feat(budget): frontend budget editor + variance dashboard"
git push origin main
```

---

## Task 14: Live verification + finalize

**Files:** none (verification only)

- [ ] **Step 1: Live end-to-end smoke** against the Atlas dev DB on a demo business, **self-cleaning** (mirror the payroll smoke approach). Write a throwaway script in the backend dir (no dev server running) that:
  1. Picks a business + fiscal year (create a short fiscal year if none).
  2. `createDraft` with one expense line budgeted below expected, `submitForApproval`, `approve` as a different user (proving SoD + activation).
  3. Posts a real transaction (via `transaction.service.createTransaction`) that breaches the line.
  4. Asserts a `FinancialAlert` with `ruleKey` starting `budget_variance:` was upserted.
  5. `computeVariance` returns the breaching line as `red` with `variance = actual − budget`.
  6. Reverses/deletes the temp transaction, deletes the budget + alert + temp fiscal year → books and alerts netted clean.
  Delete the script afterward.

- [ ] **Step 2: Run the ledger drift guard** (must read 0 — variance is read-only but confirm nothing wrote to the ledger):

Run (backend): `node scripts/ledgerDrift.js`
Expected: every business drift 0.

- [ ] **Step 3: Final full backend suite.**

Run: `npm test`
Expected: all green.

- [ ] **Step 4: Update memory** `srs-gap-closure-plan.md` — mark Phase 3 done with the backend/frontend HEAD commits, the key gotchas discovered, and "Next: Phase 4 Cost Accounting".

- [ ] **Step 5: Final summary to the user** — plain language: what budgeting does, how variance/alerts work, what was proven live, what was deferred.

---

## Self-Review

**Spec coverage:**
- FR-04.1 versioning → Task 2 (version field, active-uniqueness index), Task 6 (cloneVersion). ✓
- FR-04.1 approval chain configurable → Task 6 (reuses `approvalEngine.buildChain`). ✓
- FR-04.1 actuals auto-pulled from GL → Task 7 (`actualsByLine` via `EFFECTIVE_LINES_STAGE`). ✓
- FR-04.1 three entry methods → seed (Task 5), split (Task 4 `splitEvenly` + Task 13 client mirror), manual grid (Task 13). ✓
- FR-04.2 variance = actual − budget, reversed for revenue → Task 8 (favorability + sign). ✓
- FR-04.2 alerts within 60s of GL posting → Task 9 (`checkBreaches`) + Task 10 (event subscriber, near-instant). ✓
- FR-04.2 drillable to journal entries → Task 8 (`drillFilter`) + Task 13 (row link). ✓
- Multi-scenario → Task 2 (scenario enum), threaded through service/variance/UI. ✓

**Placeholder scan:** Task 13 steps 2–3 describe pages rather than show full JSX — this is intentional (frontend pages are large and must match live conventions discovered at execution time); every data contract they depend on (API shape, `drillFilter`, `splitEvenly`) is fully specified in earlier tasks. No backend step contains a placeholder.

**Type consistency:** `key(accountId, cc)` format `accountId|cc` used identically in Task 7 (build) and Task 8 (lookup). `rag` values `green|amber|red` consistent across Tasks 8/9/13. `drillFilter` shape `{accountId, costCenterId, from, to}` defined in Task 8, consumed in Task 13. Repo method names (`findOwnedById`, `findActive`, `findActiveByFiscalYear`, `findVersions`) consistent between Task 3 and their callers. `fyRepo` methods (`findOwnedById`, `findPrior`, `findContaining`) introduced in Tasks 5/9 and used consistently.

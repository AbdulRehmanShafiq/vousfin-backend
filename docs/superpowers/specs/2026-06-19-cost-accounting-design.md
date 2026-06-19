# Cost Accounting — Design Spec (SRS FR-07.2, FR-07.3, FR-07.4)

**Date:** 2026-06-19
**Phase:** SRS gap-closure Phase 4 (depends on Phase 1 cost-centres + existing Inventory/GL)
**Status:** Approved for planning (user pre-authorized build-through)

## Goal

Give the business three cost tools that read the real general ledger:
1. **Job costing** — track what a job/project actually costs (materials, labour,
   overhead) against its budget, and move the finished cost into stock when done.
2. **Profitability by dimension** — see which customers, products, and
   departments/projects actually make money (and which lose it).
3. **Break-even & what-if** — work out how much you must sell to cover costs, and
   play with price/cost/volume without touching real data.

## SRS acceptance criteria (bound to the real Node/Mongo/GL stack)

- **FR-07.2** — "Material, Labour, Overhead variances reported separately. Completed
  jobs transfer cost to Finished Goods / WIP."
- **FR-07.3** — "Contribution Margin = Revenue − Variable Costs … drillable …
  exportable with pivot." Gross Margin per segment; loss-makers flagged.
- **FR-07.4** — "Break-Even = Fixed Costs / (Price − Variable Cost per Unit). What-if
  recomputes P&L impact without modifying actual data. Scenarios comparable."

## Scope decisions

- **GL-native throughout.** Profitability reads the canonical
  `transaction.repository.EFFECTIVE_LINES_STAGE` (base currency, compound-aware) and
  the dimension fields already on every `JournalEntry`: `customerId`,
  `inventoryItemId`, and per-line `costCenterId`. No parallel data store.
- **Job costing posts to the GL** (real WIP): each cost posts `Dr Work in Progress
  (1169) / Cr <source account>`; completion posts `Dr Inventory (1150, used as
  Finished Goods) / Cr Work in Progress (1169)` for the accumulated actual cost.
  No new chart-of-accounts entries needed (reuses 1169 + 1150).
- **Variances are reported, not journalised.** `actual − standard`, split into
  material/labour/overhead — shown on the job, not posted (SRS says "reported").
- **Profitability dimensions (v1): `customer`, `product`, `cost_center`** — all three
  are GL-native. `region` / `salesperson` are **deferred** (not on the GL; would need
  invoice-line metadata).
- **Variable cost proxy = Direct Cost.** Accounts with `accountSubtype === 'Direct
  Cost'` (e.g. COGS 5110) are treated as variable; everything else fixed. This makes
  Contribution Margin and Break-even computable from the existing chart with no extra
  per-account flag. Documented as the rule.
- **Break-even / what-if are stateless compute** — pure functions over inputs the
  caller supplies; nothing is mutated. An `estimateFromActuals` helper pre-fills the
  inputs from a period's GL (fixed = non-direct expenses, variable = direct costs).
  **Saving/comparing scenarios is client-side** (the compute is instant and fully
  reproducible from its inputs); persisted named scenarios are **deferred** (YAGNI).
- **Export = CSV** (client-side, no new dependency) rather than native XLSX — opens in
  Excel/Sheets, satisfies the "exportable" intent for a FYP. Pivot grouping is the
  table's dimension grouping.

## Reused infrastructure (verified to exist)

| Need | Reuse |
|------|-------|
| GL actuals (base currency, compound-aware) | `transaction.repository.EFFECTIVE_LINES_STAGE` + `REPORT_STATUSES` |
| Dimension tags | `JournalEntry.customerId`, `.inventoryItemId`, line/entry `.costCenterId` |
| Posting (WIP / completion) | `ledgerPosting.postBalancedJournal` (sets balanced lines; caller supplies `inputMethod`, `createdBy`) |
| Names for segments | `Customer`, `InventoryItem` (`name`, `unitCostPrice`), `CostCenter` |
| Cost-centre validation | `costCenter.service.validateAssignable` |
| Layer pattern / repo base | `BaseRepository`, `ApiError`, `ApiResponse` |

## FR-07.2 — Job Costing

### `models/Job.model.js`
```
{
  businessId, code (unique per business), name, customerId|null,
  status: 'open' | 'in_progress' | 'completed' | 'cancelled',
  standardCost: { material, labour, overhead },   // the budget (Number, default 0)
  costSheet: [{                                    // accumulated actuals
    date, category: 'material'|'labour'|'overhead', description,
    amount, sourceAccountId, journalEntryId
  }],
  wipJournalEntryIds: [ObjectId], completionJournalEntryId|null,
  completedAt|null, createdBy
}
```
- Constants: `JOB_STATUS` + `JOB_STATUS_TRANSITIONS` (`open→in_progress→completed`,
  `open→cancelled`, `in_progress→cancelled`), `JOB_COST_CATEGORIES =
  ['material','labour','overhead']`. `canTransition` static.
- `actualCost` (material/labour/overhead totals) is **derived** from `costSheet`
  (a virtual / computed in the service), never stored stale.

### `repositories/job.repository.js`
Extends `BaseRepository`: `findByCode`, `findOwned(businessId, filters)`,
`findOwnedById(businessId, id)` (live doc for cost-sheet pushes).

### `services/jobCosting.service.js`
- `createJob(businessId, payload, user)` — dup-code 409 pre-check; validates
  customer (if given) & status `open`.
- `addCost(businessId, jobId, { category, amount, sourceAccountId, description }, user)`
  — job must be `open`/`in_progress`; posts `Dr 1169 WIP / Cr sourceAccountId`
  (`postBalancedJournal`, `inputMethod:'form'`, `createdBy`, `entryType:'normal'`,
  `transactionSource:'manual'`, `metadata.jobId`); pushes a `costSheet` row; flips
  `open→in_progress` on first cost.
- `completeJob(businessId, jobId, user)` — must be `in_progress` with cost > 0;
  posts `Dr 1150 Inventory(FG) / Cr 1169 WIP` for Σ actual cost; status →
  `completed`; sets `completionJournalEntryId`, `completedAt`.
- `cancelJob` — only before completion; reverses WIP postings (so WIP nets to 0).
- `computeActuals(job)` → `{ material, labour, overhead, total }` from costSheet.
- `computeVariance(job)` → per category `{ standard, actual, variance: actual−standard,
  favourable: actual ≤ standard }` + totals (FR-07.2 "reported separately").
- `listJobs`, `getJob` (returns job + actuals + variance).

## FR-07.3 — Profitability by dimension

### `services/profitability.service.js`
- `byDimension(businessId, dim, { from, to })`, `dim ∈ {customer, product, cost_center}`:
  - Aggregate `JournalEntry`: match businessId + date range + `REPORT_STATUSES` +
    `isArchived:{$ne:true}`; `EFFECTIVE_LINES_STAGE`; `$unwind effectiveLines`;
    `$lookup chartofaccounts` for `accountType`/`accountSubtype`.
  - **Dimension key:** `customer`→`$customerId`; `product`→`$inventoryItemId`;
    `cost_center`→`$ifNull[effectiveLines.costCenterId, $costCenterId]`.
  - Per segment: `revenue = Σ effectiveLines.amount where accountType='Revenue' AND
    type='credit'`; `variableCost = Σ where accountSubtype='Direct Cost' AND
    type='debit'`.
  - `grossMargin = revenue − variableCost`; `grossMarginPct = revenue ? grossMargin/revenue
    : null`; `contributionMargin = revenue − variableCost` (same proxy);
    `lossMaker = grossMargin < 0`.
  - Drop the null-key bucket (entries with no value for that dimension) into an
    "Unassigned" row. Sort by `grossMargin` desc.
  - Join names: `Customer.name` / `InventoryItem.name` / `CostCenter.name`.
- Returns `{ dim, from, to, segments: [{ id, name, revenue, variableCost, grossMargin,
  grossMarginPct, contributionMargin, lossMaker }], totals }`.

## FR-07.4 — Break-even & what-if

### `services/breakEven.service.js` (pure compute, no DB writes)
- `breakEvenPoint({ fixedCosts, pricePerUnit, variableCostPerUnit })`:
  - `cmPerUnit = pricePerUnit − variableCostPerUnit`; if `cmPerUnit ≤ 0` →
    `{ feasible:false, reason:'Price must exceed variable cost per unit' }`.
  - `units = fixedCosts / cmPerUnit` (ceil for whole units + exact); `revenue = units×price`;
    `cmRatio = cmPerUnit / pricePerUnit`. Returns `{ feasible:true, breakEvenUnits,
    breakEvenRevenue, cmPerUnit, cmRatio }`.
- `whatIf({ fixedCosts, pricePerUnit, variableCostPerUnit, expectedUnits, targetProfit })`:
  - Recompute BEP; `projectedProfit = expectedUnits×cmPerUnit − fixedCosts`;
    `unitsForTargetProfit = (fixedCosts + targetProfit) / cmPerUnit`. Pure — never writes.
- `estimateFromActuals(businessId, { from, to })` — seed inputs from the GL: aggregate
  expenses where `accountSubtype='Direct Cost'` → `variableCosts`; other expenses →
  `fixedCosts`; revenue total. Returns suggested `{ fixedCosts, variableCosts, revenue }`
  (the UI maps these into the per-unit fields). Read-only.

## Controllers / routes — mount `/cost`

`controllers/cost.controller.js` + `routes/v1/cost.routes.js` (`authMiddleware` +
`requireBusiness`, `validate` default export):

| Method | Path | Action |
|--------|------|--------|
| GET  | `/cost/jobs` | list jobs |
| POST | `/cost/jobs` | create job |
| GET  | `/cost/jobs/:id` | job + actuals + variance |
| POST | `/cost/jobs/:id/costs` | add a cost (posts to WIP) |
| POST | `/cost/jobs/:id/complete` | complete (WIP→FG) |
| POST | `/cost/jobs/:id/cancel` | cancel + reverse WIP |
| GET  | `/cost/profitability` | `?dim=customer|product|cost_center&from&to` |
| POST | `/cost/break-even` | compute BEP from inputs |
| POST | `/cost/what-if` | compute what-if from inputs |
| GET  | `/cost/break-even/estimate` | `?from&to` seed inputs from actuals |

Mount in `routes/index.js`: `router.use('/cost', costRoutes);`

## Frontend

- `src/services/cost.service.js` — api wrappers for the routes above.
- `src/pages/cost/JobCostingPage.jsx` — job list + create; per job: standard vs actual
  with material/labour/overhead variance bars (green favourable / red over), "Add cost"
  (category + amount + source account), "Complete job" (posts to stock). Plain labels:
  "Budget", "Actual", "Over/Under".
- `src/pages/cost/ProfitabilityPage.jsx` — dimension switch (Customers / Products /
  Departments), date range; table Revenue / Variable cost / Gross margin / GM% with
  loss-makers flagged; **Export CSV** button.
- `src/pages/cost/BreakEvenPage.jsx` — inputs (fixed costs, price/unit, variable
  cost/unit) with a "Fill from my numbers" button (`estimate`); shows break-even units &
  revenue; **what-if sliders** (expected units, target profit) updating projected profit
  live, fully client-side; add multiple scenarios side-by-side for comparison.
- Nav: new **"Cost & Profit"** section in `nav.config.js` (GOLD accent); lazy routes
  `/cost/jobs`, `/cost/profitability`, `/cost/break-even` via `withSuspense()`.

## Worked examples (lock the math)

- **Job variance:** standard material 50,000; actual material (Σ costSheet material)
  58,000 → variance +8,000 **unfavourable** (over budget).
- **Profitability (customer):** Customer A revenue 540,000, direct cost 360,000 →
  gross margin 180,000, GM% 33.3%, not a loss-maker. Customer B revenue 100,000, direct
  cost 130,000 → gross margin −30,000 → **loss-maker** flag.
- **Break-even:** fixed 300,000; price 500; variable 300 → cm/unit 200; break-even
  units = 1,500; revenue = 750,000. At expectedUnits 2,000 → profit = 2,000×200 −
  300,000 = 100,000.

## Testing (TDD, mocked models — never `{ virtual:true }`; tests live in `tests/unit/...`)

- `tests/unit/services/jobCosting.service.test.js` — addCost posts Dr WIP/Cr source &
  appends costSheet; status open→in_progress→completed; completeJob posts WIP→FG for Σ
  actual; computeVariance 3-way (material/labour/overhead, favourable flag); cancel
  reverses; dup-code 409; canTransition.
- `tests/unit/services/profitability.service.test.js` — CM/GM math, revenue/direct-cost
  classification, loss-maker flag, dimension key per `dim` (customer/product/cost_center),
  null→Unassigned bucket, revenue=0 → GM% null.
- `tests/unit/services/breakEven.service.test.js` — BEP units/revenue, cm≤0 infeasible,
  whatIf projectedProfit + unitsForTargetProfit, estimateFromActuals classification,
  purity (no writes).
- `tests/unit/models/job.model.test.js` — canTransition + defaults.
- `tests/unit/controllers/cost.controller.test.js` — delegation smoke.
- `tests/integration/cost.flow.test.js` — create job → add costs → complete (asserts
  WIP→FG balanced); profitability over a small GL fixture; break-even compute.

## Out of scope / non-goals

- No overhead **absorption rate** engine (overhead is added as actual cost lines, not
  applied via a pre-determined rate) — keeps job costing simple; rate-based absorption
  deferred.
- No `region` / `salesperson` profitability (not on the GL).
- No persisted/named break-even scenarios (client-side comparison only).
- No variance **journal posting** (variances reported, not booked).
- Export is CSV, not native XLSX.

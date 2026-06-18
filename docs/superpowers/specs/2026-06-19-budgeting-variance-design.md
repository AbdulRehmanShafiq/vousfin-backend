# Budgeting & Variance — Design Spec (SRS FR-04.1, FR-04.2)

**Date:** 2026-06-19
**Phase:** SRS gap-closure Phase 3 (depends on Phase 1 cost-centres)
**Status:** Approved for planning

## Goal

Let a business plan expected income and spending per account (a **budget**), then
continuously compare the live general ledger against that plan (**variance**) and
raise an alert within 60 seconds when an account drifts past its threshold.

## SRS acceptance criteria (bound to the real Node/Mongo stack)

- **FR-04.1** — "Budget entries version-controlled with full history. Approval chain
  configurable. Actuals auto-pulled from GL in real time."
- **FR-04.2** — "Variance = Actual − Budget (reversed for revenue). Alerts fire within
  60 seconds of a GL posting that causes a threshold breach. Variance drillable to
  individual journal entries."

## Scope decisions (confirmed with user)

- **Multi-scenario in v1:** every fiscal year can hold three independent budgets —
  `base`, `optimistic`, `pessimistic`. Each is versioned and approved independently.
- **Three entry methods, all in v1:**
  1. **Seed from last year** — one click pre-fills every line's 12 months from the
     prior fiscal year's GL actuals per account (+cost-centre).
  2. **Annual → auto-split** — type one yearly figure per account; spread evenly over
     12 months (any month still individually editable).
  3. **Manual grid** — plain account × 12-month grid, every cell editable.
- **Deferred (YAGNI, no migration needed later):** rolling/quarterly re-forecasts,
  budget-vs-budget scenario comparison charts, Excel/CSV budget import.

## Reused existing infrastructure (verified to exist)

| Need | Reuse |
|------|-------|
| Approval chain + SoD (creator ≠ approver) | `services/approvalEngine.service.js` — `buildChain(amount,opts)`, `approveStep(doc,user,note)`, `rejectStep`, `summarize`. Operates on `doc.approvalChain` + `doc.createdBy`. |
| GL actuals (base currency, compound-aware) | `transaction.repository.EFFECTIVE_LINES_STAGE` (journalLines if present, else synthesised debit/credit pair at `baseCurrencyAmount`). |
| Real-time trigger | `businessEventEngine` event `TRANSACTION_CREATED` (`'transaction.created'`) + `TRANSACTION_REVERSED`. **There is no `JOURNAL_POSTED` event** — bind to these. |
| Alert persistence + once-per-period dedup | `models/FinancialAlert.model.js` — unique index `{businessId, ruleKey, periodKey}`. |
| Event wiring point | `services/eventSubscribers.service.js` `registerAll()` (idempotent, fire-and-forget, error-isolated). |
| Fiscal year boundaries | `models/FiscalYear.model.js` — `{ startDate, endDate, status }`. |
| Cost-centre validation | `services/costCenter.service.js` `validateAssignable` (Phase 1). |

## Data model — `models/Budget.model.js`

```
{
  businessId:      ObjectId(ref Business)  // indexed
  name:            String                  // e.g. "FY 2025-26 Operating Budget"
  fiscalYearId:    ObjectId(ref FiscalYear)
  scenario:        'base' | 'optimistic' | 'pessimistic'   // default 'base'
  version:         Number                  // 1, 2, 3 … (clone increments)
  status:          'draft' | 'pending_approval' | 'active' | 'rejected' | 'archived'
  defaultThresholdPct: Number              // default 10 — variance alert band
  approvalChain:   [ approvalStep ]        // built by approvalEngine.buildChain
  createdBy:       ObjectId(ref User)      // required for SoD
  lines: [{
    accountId:     ObjectId(ref ChartOfAccount)   // required
    costCenterId:  ObjectId(ref CostCenter)|null  // optional dimension
    monthly:       [Number] (length 12)            // index 0 = fiscal month 1
    thresholdPct:  Number|null                     // per-line override of default
  }]
}
```

- **Constants** added to `config/constants.js`: `BUDGET_STATUS`, `BUDGET_STATUS_TRANSITIONS`
  (`draft→pending_approval`, `pending_approval→active`, `pending_approval→rejected`,
  `rejected→draft`, `active→archived`), `BUDGET_SCENARIOS`.
- **Annual** for a line = `sum(monthly)`. Always store all 12 months — even-split and
  seed simply produce those 12 values at entry time, so reads never re-derive.
- **Immutability:** a budget is editable only in `draft`. Once `active` it is frozen;
  revising it = `clone` → new `draft` at `version+1`. Approving the clone auto-archives
  the prior `active` budget of the same `{fiscalYearId, scenario}`.
- **Indexes:** `{businessId, fiscalYearId, scenario, version}`; partial unique index on
  `{businessId, fiscalYearId, scenario}` where `status:'active'` — at most one active
  budget per scenario per year.
- `canTransition(from, to)` static using `BUDGET_STATUS_TRANSITIONS` (mirrors the
  payroll-run model pattern).

## `repositories/budget.repository.js`

Extends `BaseRepository`. Adds:
- `findActive(businessId, fiscalYearId, scenario)`
- `findVersions(businessId, fiscalYearId, scenario)` (sorted by version desc)
- `findOwned(businessId, filters)` (list with fy/scenario/status filters)

## `services/budget.service.js`

- `createDraft(businessId, payload, user)` — validates accounts exist & cost-centres
  assignable (`costCenter.service.validateAssignable`); sets `version:1`, `status:'draft'`,
  `createdBy`.
- `updateDraft(businessId, id, payload, user)` — **rejects** if status ≠ draft (409).
- `seedFromActuals(businessId, fiscalYearId, { scenario })` — reads the **prior** fiscal
  year's actuals per account (+cost-centre) through `EFFECTIVE_LINES_STAGE`, mapped month
  for month into a fresh line set. Returns a preview payload (not persisted) the editor
  loads into the grid.
- `splitEvenly(annualAmount)` util → 12-element array (`amount/12`, last cell absorbs the
  rounding remainder so `sum === annualAmount`).
- `submitForApproval(businessId, id, user)` — builds `approvalChain` via
  `approvalEngine.buildChain(totalAnnualBudget)`, status `draft → pending_approval`.
- `approve(businessId, id, user, note)` — `approvalEngine.approveStep`; when
  `fullyApproved`, status → `active` and the prior active budget of the same
  `{fy, scenario}` is set to `archived` (single repo update).
- `reject(businessId, id, user, note)` — `approvalEngine.rejectStep`, status → `rejected`.
- `cloneVersion(businessId, id, user)` — deep-copies lines into a new `draft` at
  `version+1` (the edit path for an active budget).
- `getActive`, `getById`, `list`.

## `services/variance.service.js`

- `actualsByLine(businessId, { fiscalYearId, from, to })` → aggregation over `JournalEntry`
  (match businessId + date range + `isArchived:{$ne:true}` + balance-affecting statuses),
  `EFFECTIVE_LINES_STAGE`, `$unwind`, `$addFields lineCostCenter = $ifNull[effectiveLines.costCenterId, $costCenterId]`,
  group by `{accountId, lineCostCenter}` summing debit and credit separately. Returns a map
  keyed `accountId|costCenterId`.
- `computeVariance(businessId, budgetId, { asOf })` — for each budget line:
  - Resolve the account type (Revenue vs Expense vs other) via account repo.
  - **Actual** (natural sign, positive when normal): Revenue = `credits − debits`;
    everything else = `debits − credits`.
  - **Budget** for the window = sum of `monthly` up to the fiscal month containing `asOf`
    (YTD); full year when `asOf` ≥ fiscal year end.
  - `variance = actual − budget`; `variancePct = variance / |budget|` (guard `budget===0`
    → pct `null`, treated as informational).
  - **Favorability** (SRS "reversed for revenue"): Revenue → `actual ≥ budget` is *favorable*;
    Expense → `actual ≤ budget` is *favorable*.
  - **RAG:** `green` if favorable **or** `|pct| ≤ threshold`; `amber` if unfavorable and
    `threshold < |pct| ≤ 2×threshold`; `red` if unfavorable and `|pct| > 2×threshold`.
    Threshold = line `thresholdPct` ?? budget `defaultThresholdPct`.
  - Each line returns a `drillFilter` (`{accountId, costCenterId, from, to}`) the frontend
    turns into a Transactions-page link.
- `checkBreaches(businessId, affectedAccountIds, { asOf })` — invoked by the event
  subscriber. Loads the **active** budget(s) whose fiscal year contains the entry date,
  recomputes variance for **only** the affected lines, and for each line at `red` (or
  `amber`, configurable — default red) fires a `FinancialAlert`:
  - `ruleKey: 'budget_variance:<budgetId>:<accountId>:<costCenterId|->'`
  - `periodKey:` the budget's fiscal-month key (`YYYY-MM`) — gives once-per-month dedup
    via the model's unique index.
  - `level:` `red`→`critical`, `amber`→`warning`. `what/howMuch/recommendation` in plain
    language; `actionTo` → variance dashboard route; `data` carries raw numbers.

## Events — `services/eventSubscribers.service.js`

Add inside `registerAll()`:

```
businessEvents.on(EVENTS.TRANSACTION_CREATED, budgetVarianceHandler, { name: 'budget-variance-check' });
businessEvents.on(EVENTS.TRANSACTION_REVERSED, budgetVarianceHandler, { name: 'budget-variance-check:reversed' });
```

`budgetVarianceHandler(evt)` — guard on `evt.businessId`; lazy-require `variance.service`;
extract affected account IDs from the event payload (fall back to loading the entry's
effective lines); call `variance.checkBreaches`. Fire-and-forget + error-isolated like the
existing subscribers — a variance failure can never unwind the posting. Near-instant, well
inside the 60s SRS bound.

## Controllers / routes — mount `/budgets`

`controllers/budget.controller.js` (thin) + `routes/v1/budget.routes.js`
(`authMiddleware` + `requireBusiness`, `validate` default export — mirrors payroll routes):

| Method | Path | Action |
|--------|------|--------|
| GET  | `/budgets` | list (filter `?fiscalYearId&scenario&status`) |
| POST | `/budgets` | create draft |
| GET  | `/budgets/:id` | get one (+ variance summary) |
| PUT  | `/budgets/:id` | update draft |
| POST | `/budgets/seed` | seed-from-actuals preview (body: `fiscalYearId, scenario`) |
| POST | `/budgets/:id/submit` | submit for approval |
| POST | `/budgets/:id/approve` | approve current step |
| POST | `/budgets/:id/reject` | reject |
| POST | `/budgets/:id/clone` | clone → new draft version |
| GET  | `/budgets/:id/variance` | variance report (`?asOf`) |

Mount in `routes/index.js`: `router.use('/budgets', budgetRoutes);`

## Frontend

- `src/services/budget.service.js` — api wrappers for the routes above.
- `src/pages/budget/BudgetEditorPage.jsx` — pick fiscal year + scenario; account × 12-month
  grid grouped by account type; toolbar **"Seed from last year"**, per-row **annual → split**,
  manual cell edit; Save draft → Submit → (approver) Approve / Reject; Clone to revise an
  active budget. Plain-language labels ("Budget / Plan", "Expected income", "Expected
  spending", "Take-home"-style wording).
- `src/pages/budget/VarianceDashboardPage.jsx` — scenario switcher; RAG table per account &
  cost-centre (Budget vs Actual vs Variance vs %, colour-coded green/amber/red); click a row
  → Transactions page filtered to that account/cost-centre/date range (drill-through).
- Nav: new **"Budgets"** section in `nav.config.js` (distinct accent); lazy routes in
  `routes.jsx` (`/budgets/editor`, `/budgets/variance`) via `withSuspense()`.

## Sign-convention worked example

Account = "Office Rent" (Expense), budget Jan = 100,000, actual Jan = 130,000,
`defaultThresholdPct = 10`:
- actual = debits − credits = 130,000; variance = 130,000 − 100,000 = +30,000;
  pct = +0.30. Expense + actual > budget ⇒ **unfavorable**. |0.30| > 2×0.10 ⇒ **red** →
  `critical` alert.

Account = "Sales Revenue" (Revenue), budget = 500,000, actual = 540,000:
- actual = credits − debits = 540,000; variance = +40,000; pct = +0.08. Revenue +
  actual > budget ⇒ **favorable** ⇒ **green**, no alert.

## Testing (TDD, mocked models — no live DB; never `{ virtual:true }`)

- `__tests__/services/variance.service.test.js` — actual sign per account type, revenue
  favorability flip, RAG bands (green/amber/red), `budget===0` guard, YTD vs full-year
  window, cost-centre grouping (line-level + entry-level fallback).
- `__tests__/services/budget.service.test.js` — `splitEvenly` remainder, `seedFromActuals`
  (mocked aggregation), `createDraft` validation, `updateDraft` rejects non-draft,
  submit→approve→active archives prior, SoD (creator can't approve), `cloneVersion`
  increments + resets to draft, `canTransition`.
- `__tests__/services/budgetVariance.subscriber.test.js` — `checkBreaches` fires on breach,
  dedups per period, silent within threshold, ignores entries outside the active budget's
  fiscal year.
- Integration smoke: create → seed → submit → approve → post a breaching transaction →
  assert alert fired → variance report drill-through filter shape.

## Out of scope / non-goals

- No budget locking tied to fiscal-year close (budgets archive on supersede only).
- No notification-channel delivery beyond the existing `FinancialAlert` feed.
- No currency conversion in budgets — amounts are entered and compared in base currency.

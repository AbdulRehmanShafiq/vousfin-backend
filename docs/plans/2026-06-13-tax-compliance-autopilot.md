# FR-GROUP-04 — Tax & Compliance Autopilot · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **Read the named existing file before each backend task** — signatures below are derived from the route/service surface and must be confirmed against the real exports.

**Goal:** Turn VousFin's existing per-transaction tax engine into an autonomous Tax & Compliance Autopilot — a continuously-computed, always-visible tax position (FR-04.1), a proactive legal optimization advisor (FR-04.2), and a one-click return-preparation + FBR-filing pipeline with XML fallback (FR-04.3).

**Architecture:** Build ON Phase 5.4. GST input/output and WHT are already computed per transaction and posted to tax accounts (input/receivable codes 1170–1177, output/payable 2121–2130). The "live position" is therefore a *read model* over those account balances plus a computed income-tax provision and payroll obligations — no new write path on the hot transaction flow. Advisories and return builders are read-only services over the GL/tax-ledger. FBR submission is a pluggable adapter; the guaranteed path is FBR-compatible XML/PDF export, with live IRIS submission enabled only when credentials are configured.

**Tech Stack:** Node/Express/Mongoose, node-cron (existing in `server.js`), Jest (`__tests__/`, `tests/`). Frontend React 19 + Vite, TanStack Query, Zustand, react-hook-form + Zod, Tailwind (Nocturne theme tokens). PDF via the lib already used for exports; XML via `xmlbuilder2` (add dep).

**Existing surface to reuse (confirm before extending):**
- `services/taxEngine.service.js` — per-txn GST/WHT calc, `ensureTaxAccounts(businessId)`, tax account codes.
- `services/taxReport.service.js` — ledger/summary/wht/filing reporting.
- `config/countryTaxProfiles.js`, `utils/taxRules.js` — rates, WHT schedules, country rules (PK primary).
- `routes/v1/tax.routes.js` + `controllers/tax.controller.js` — `/config /enable /accounts /preview /profiles /wht-schedules /vendor/:id/wht /reports/{ledger,summary,wht,filing}`.
- Frontend: `services/tax.service.js`, `hooks/useTax.js`, `pages/settings/TaxConfigPage.jsx`, `pages/reports/TaxReportPage.jsx`, `components/ui/TaxPreviewPanel.jsx`.
- `services/auditService` (`auditService.log`), `ApiError`, `ApiResponse`, `BaseRepository` pattern, `journalGenerator.service.js`.

**UX principle (every phase):** one **Tax Autopilot** destination that reads top-to-bottom — (1) what you owe now + when it's due, (2) how to pay less (advisories), (3) file it. Plain-language headline numbers for non-experts ("You owe **Rs 142,000** GST · due in **9 days**"), with an expandable "Why / legal basis" and a drill-down to the ledger for professionals. Never more than one primary action visible per card.

---

## Phase decomposition (each phase ships working software)

- **Phase 0** — Config & calendar foundations.
- **Phase 1** — Real-time tax-position read model + API (FR-04.1 core).
- **Phase 2** — Daily position snapshots + 6-month trend (FR-04.1 trend).
- **Phase 3** — Income-tax provision + payroll (EOBI/SESSI) + WHT auto-JE verification (FR-04.1 completeness).
- **Phase 4** — Tax Autopilot page + dashboard homepage widget (FR-04.1 UI + AC "visible on homepage").
- **Phase 5** — Optimization advisor service + rule catalog + API (FR-04.2 core).
- **Phase 6** — Advisories UI + Needs-Attention feed integration (FR-04.2 UI).
- **Phase 7** — Return data model + builders: GST-01/Annex A-B-C, WHT statement, income-tax return (FR-04.3 core).
- **Phase 8** — Pre-filing validation suite + FBR rejection-rule catalog (FR-04.3 validation).
- **Phase 9** — FBR submission adapter (IRIS) + XML/PDF export fallback + audit ack (FR-04.3 filing).
- **Phase 10** — Return-filing wizard UI + returns queue (FR-04.3 UI, one-click).
- **Phase 11** — Scheduler (auto-prepare N days before deadline) + reminders.
- **Phase 12** — End-to-end acceptance-criteria verification.

---

## Phase 0 — Config & calendar foundations

### Task 0.1: Extend tax config with autopilot settings

**Files:**
- Modify: `models/` tax config schema (find via `controllers/tax.controller.js` `getConfig`/`updateConfig` — it reads a `TaxConfig` or a field on `Business`). Add fields.
- Modify: `validations/tax.validation.js` (`updateTaxConfigSchema`).
- Test: `__tests__/taxConfig.autopilot.test.js`

- [ ] **Step 1:** Read `controllers/tax.controller.js` to locate where config is stored (TaxConfig model vs Business sub-doc). Note the exact path.
- [ ] **Step 2:** Add fields to that schema: `incomeTaxProvisionRate` (Number, default 0.29 — PK company rate; configurable), `filingMode` ('xml' | 'iris', default 'xml'), `fbrCredentials` ({ ntn, irisToken } — encrypted/optional), `autoPrepareDaysBefore` (Number, default 5), `payrollEnabled` (Boolean, default false).
- [ ] **Step 3:** Extend `updateTaxConfigSchema` (Joi/Zod per existing style) to accept the new fields, all optional, with ranges (`incomeTaxProvisionRate` 0–0.5, `autoPrepareDaysBefore` 1–30, `filingMode` enum).
- [ ] **Step 4:** Write test: updating config persists the new fields and rejects out-of-range `incomeTaxProvisionRate`.
- [ ] **Step 5:** Run `npm run test:unit -- taxConfig.autopilot` → PASS. Commit `feat(tax): autopilot config fields`.

### Task 0.2: Define the PK filing calendar

**Files:**
- Create: `config/taxFilingCalendar.js`
- Test: `__tests__/taxFilingCalendar.test.js`

- [ ] **Step 1:** Create `config/taxFilingCalendar.js` exporting, per country code, a list of obligations with deadline rules:
```js
// Each rule yields the next due date for a given "as of" date.
module.exports = {
  PK: [
    { taxType: 'GST',        label: 'Sales Tax Return (GST-01)', frequency: 'monthly',   dueDay: 18,  returnType: 'GST-01' },
    { taxType: 'WHT',        label: 'WHT Statement (165)',       frequency: 'monthly',   dueDay: 15,  returnType: 'WHT-165' },
    { taxType: 'INCOME_TAX', label: 'Income Tax Return',         frequency: 'annual',    dueMonth: 9, dueDay: 30, returnType: 'IT-RETURN' },
    { taxType: 'EOBI',       label: 'EOBI Contribution',         frequency: 'monthly',   dueDay: 15,  returnType: 'EOBI' },
    { taxType: 'SESSI',      label: 'SESSI Contribution',        frequency: 'monthly',   dueDay: 15,  returnType: 'SESSI' },
  ],
};
```
- [ ] **Step 2:** Create `utils/nextDeadline.js` with `nextDeadline(rule, asOf = new Date())` returning `{ dueDate: Date, daysRemaining: Number }`. Monthly: next occurrence of `dueDay` (this month if not passed, else next month). Annual: next `dueMonth/dueDay`.
- [ ] **Step 3:** Test: for `GST` rule and asOf = 2026-06-10, dueDate = 2026-06-18, daysRemaining = 8; for asOf = 2026-06-20, dueDate = 2026-07-18.
- [ ] **Step 4:** Run test → PASS. Commit `feat(tax): PK filing calendar + next-deadline util`.

---

## Phase 1 — Real-time tax-position read model + API (FR-04.1 core)

### Task 1.1: Tax position service (read model over tax accounts)

**Files:**
- Create: `services/taxPosition.service.js`
- Test: `tests/integration/taxPosition.service.test.js` (integration — seeds a business + tax txns)

- [ ] **Step 1:** Read `services/taxEngine.service.js` to confirm the exact account codes/names for GST input (receivable) and GST output (payable), and the WHT payable account. Record them.
- [ ] **Step 2:** Create `taxPosition.service.js` with `getLivePosition(businessId)` returning, per tax type, the net liability computed from current `ChartOfAccount` running balances:
```js
// GST: output payable − input receivable (net payable, floored at 0 for display but keep raw for refund case)
// WHT: balance of WHT payable account (collected, not yet remitted)
// INCOME_TAX: provisionRate × max(0, netProfitYTD)  (Task 3.1 supplies netProfitYTD)
// EOBI/SESSI: from payroll accruals if payrollEnabled, else 0 with status 'not_tracked'
async function getLivePosition(businessId) { /* read balances via accountRepository */ }
```
Return shape (stable contract used by UI + returns):
```js
{
  asOf: ISOString,
  currency: 'PKR',
  taxes: [
    { taxType, label, liability: Number, refundable: Boolean,
      nextDeadline: { dueDate, daysRemaining, returnType }, status }
  ],
  totalPayable: Number,
}
```
- [ ] **Step 3:** Compose `nextDeadline` from `config/taxFilingCalendar.js` + `utils/nextDeadline.js` per tax type.
- [ ] **Step 4:** Integration test: seed a business with one taxable sale (output tax) + one eligible purchase (input tax); assert GST liability == output − input and deadline daysRemaining is correct.
- [ ] **Step 5:** Run `npm run test:integration -- taxPosition` → PASS. Commit `feat(tax): live tax-position read model`.

### Task 1.2: Position endpoint + controller + route + frontend client

**Files:**
- Modify: `controllers/tax.controller.js` (add `getPosition`), `routes/v1/tax.routes.js` (add `GET /position`)
- Modify: `vousfin-frontend-main/src/services/tax.service.js`, `src/hooks/useTax.js`
- Test: `tests/integration/tax.position.route.test.js`

- [ ] **Step 1:** Add controller `getPosition(req,res)` → `ApiResponse.success(res, await taxPositionService.getLivePosition(req.business._id))`. Follow the thin-controller pattern from existing `taxLedger`.
- [ ] **Step 2:** Add `router.get('/position', taxCtrl.getPosition);` under the Reporting section of `tax.routes.js`.
- [ ] **Step 3:** Frontend: add `getPosition: () => api.get('/tax/position')` to `tax.service.js`; add `useTaxPosition()` to `useTax.js` (TanStack Query, `queryKey: ['tax','position', businessId]`, `staleTime: 30_000`, `enabled: !!businessId`).
- [ ] **Step 4:** Wire invalidation: in `vousfin-frontend-main/src/hooks/useTransactions.js`, every mutation already invalidates `['reports']` — add `queryClient.invalidateQueries({ queryKey: ['tax'] })` to the same handlers so the position refreshes within seconds of a posting (AC: ≤10s).
- [ ] **Step 5:** Integration test on `GET /api/v1/tax/position` returns 200 with the contract shape. Run → PASS. Commit `feat(tax): position endpoint + query hook + invalidation`.

---

## Phase 2 — Daily snapshots + 6-month trend (FR-04.1 trend)

### Task 2.1: Snapshot model + writer

**Files:**
- Create: `models/taxPositionSnapshot.model.js`, `repositories/taxPositionSnapshot.repository.js` (extends `BaseRepository`)
- Create: `services/taxSnapshot.service.js`
- Test: `tests/integration/taxSnapshot.service.test.js`

- [ ] **Step 1:** Model: `{ businessId (indexed), date (YYYY-MM-DD, indexed), taxes: [{ taxType, liability }], totalPayable }`, unique compound index `{ businessId, date }`.
- [ ] **Step 2:** Repo extends `BaseRepository`; add `upsertForDate(businessId, date, payload)` and `trend(businessId, fromDate)` (sorted ascending).
- [ ] **Step 3:** Service `captureSnapshot(businessId)` → reads `taxPositionService.getLivePosition`, upserts today's snapshot (idempotent re-run safe).
- [ ] **Step 4:** Integration test: capture twice in a day → one row; trend returns rows for the last 6 months.
- [ ] **Step 5:** Run → PASS. Commit `feat(tax): daily position snapshots`.

### Task 2.2: Cron schedule + trend endpoint

**Files:**
- Modify: `server.js` (node-cron block), `controllers/tax.controller.js`, `routes/v1/tax.routes.js`
- Modify frontend: `tax.service.js`, `useTax.js`

- [ ] **Step 1:** In `server.js`, alongside existing jobs, add a daily 00:30 cron that iterates active businesses with tax enabled and calls `taxSnapshot.captureSnapshot`. Wrap each in try/catch so one failure doesn't abort the loop.
- [ ] **Step 2:** Add `getPositionTrend` controller + `GET /position/trend?months=6` route → `snapshotRepo.trend(businessId, sixMonthsAgo)`.
- [ ] **Step 3:** Frontend `getPositionTrend: (months=6) => api.get('/tax/position/trend', { params:{ months } })` + `useTaxTrend(months)`.
- [ ] **Step 4:** Manual verify: run `node scripts/...` or trigger the service once; confirm a snapshot row appears. Commit `feat(tax): snapshot cron + trend endpoint`.

---

## Phase 3 — Income-tax provision, payroll obligations, WHT auto-JE (FR-04.1 completeness)

### Task 3.1: Net-profit-YTD source + income-tax provision

**Files:**
- Modify: `services/taxPosition.service.js`
- Test: extend `tests/integration/taxPosition.service.test.js`

- [ ] **Step 1:** Reuse the existing income-statement service (the one behind `/reports/income-statement`) to get `netProfitYTD` for the current fiscal year; import and call it inside `taxPosition.service.js` rather than recomputing.
- [ ] **Step 2:** Compute `incomeTaxProvision = round(config.incomeTaxProvisionRate × max(0, netProfitYTD))`; add it as the `INCOME_TAX` entry in `getLivePosition`.
- [ ] **Step 3:** Test: seed P&L with net profit 1,000,000 + rate 0.29 → provision 290,000.
- [ ] **Step 4:** Run → PASS. Commit `feat(tax): continuous income-tax provision`.

### Task 3.2: WHT auto-journal verification (or implement if missing)

**Files:**
- Inspect: `services/taxEngine.service.js`, `services/journalGenerator.service.js`
- Test: `tests/integration/wht.autojournal.test.js`

- [ ] **Step 1:** Read `taxEngine.service.js` to determine whether posting a qualifying vendor payment already books a WHT deduction journal entry (debit payable/expense, credit WHT-payable). Write an integration test asserting it does.
- [ ] **Step 2:** If the test fails (no auto-JE), add the entry in the payment-posting path via `journalGenerator`, tagged `transactionSource: 'system_generated'`, account = WHT payable.
- [ ] **Step 3:** Run → PASS. Commit `feat(tax): WHT auto-journal on qualifying payment` (or `test(tax): assert existing WHT auto-journal`).

### Task 3.3: Payroll obligations (EOBI/SESSI) — minimal, flag-gated

**Files:**
- Modify: `services/taxPosition.service.js`
- Create (only if no payroll model exists): `models/payrollAccrual.model.js` + a manual `POST /tax/payroll-accrual` to record monthly employer obligation.
- Test: `tests/integration/taxPosition.payroll.test.js`

- [ ] **Step 1:** Check for an existing payroll/employee model. If present, derive EOBI/SESSI from it.
- [ ] **Step 2:** If absent, YAGNI a full payroll module: add a tiny `payrollAccrual` record (businessId, month, eobi, sessi) and a manual entry endpoint, surfaced only when `payrollEnabled`. Position reads the latest month's accrual.
- [ ] **Step 3:** When `payrollEnabled === false`, EOBI/SESSI entries report `status:'not_tracked'` and `liability:0` (UI shows "Enable payroll to track").
- [ ] **Step 4:** Test both branches. Run → PASS. Commit `feat(tax): payroll EOBI/SESSI obligation (flag-gated)`.

---

## Phase 4 — Tax Autopilot page + homepage widget (FR-04.1 UI)

### Task 4.1: Live position cards on a Tax Autopilot page

**Files:**
- Create: `vousfin-frontend-main/src/pages/tax/TaxAutopilotPage.jsx`
- Create: `src/components/tax/TaxPositionCard.jsx`, `src/components/tax/DeadlineCountdown.jsx`, `src/components/tax/TaxTrendSparkline.jsx`
- Modify: `src/routes.jsx` (route `/tax`), `src/components/layout/nav.config.js` (Autopilot section → "Tax Autopilot", or a new top-level — see Task 4.3)

- [ ] **Step 1:** `TaxPositionCard` props `{ taxType, label, liability, refundable, nextDeadline, status, trend }`. Layout: plain headline "You owe **{fmt(liability)}**" (or "Refund due" when refundable), `DeadlineCountdown` ("due in 9 days · 18 Jun"), `TaxTrendSparkline` (6-pt). Use theme tokens; semantic color = `var(--c-highlight)` for due-soon (≤3 days → `var(--c-negative)`). `.num` for figures.
- [ ] **Step 2:** `TaxAutopilotPage`: header "Tax Autopilot" + one-line subtitle; grid of `TaxPositionCard` from `useTaxPosition()` + `useTaxTrend()`. Loading skeletons; empty state when tax disabled → CTA linking to `/settings/tax`.
- [ ] **Step 3:** Lazy-load via `withSuspense` (existing pattern). Add route. Build + preview at desktop/375px.
- [ ] **Step 4:** Commit `feat(tax): Tax Autopilot page — live position cards`.

### Task 4.2: Homepage tax widget (AC: visible on main financial homepage)

**Files:**
- Create: `src/components/dashboard/TaxPositionWidget.jsx`
- Modify: `src/pages/dashboard/Dashboard.jsx` (render inside the "Business Intelligence" section, above charts)

- [ ] **Step 1:** Compact widget: total payable headline + the single most-urgent deadline + a "View Tax Autopilot →" link. Reuses `useTaxPosition()`. Hidden gracefully if tax not enabled.
- [ ] **Step 2:** Insert into Dashboard's intelligence section. Verify it appears on the homepage (not a submenu). Build + preview.
- [ ] **Step 3:** Commit `feat(tax): homepage tax-position widget`.

### Task 4.3: Navigation entry

**Files:** Modify `src/components/layout/nav.config.js`

- [ ] **Step 1:** Add `{ name: 'Tax Autopilot', href: '/tax', icon: Landmark, desc: 'Live tax position, advisories and filing' }` to the **Autopilot** section (keeps the 4-theme rail/hub intact; no new section needed).
- [ ] **Step 2:** Confirm it appears on the Autopilot hub page + rail. Commit `feat(tax): nav entry for Tax Autopilot`.

---

## Phase 5 — Optimization advisor service + rule catalog (FR-04.2 core)

### Task 5.1: Advisory rule catalog (deterministic, auditable)

**Files:**
- Create: `config/taxOptimizationRules.js`
- Test: `tests/unit/taxOptimizationRules.test.js`

- [ ] **Step 1:** Define a rule as `{ id, taxType, legalRef, riskLevel: 'safe'|'review', title, detect(ctx) }` where `detect` returns `null` or `{ estimatedSavingPKR, explanation }`. `ctx` = `{ businessId, fixedAssets, advanceTaxPaid, projectedAnnualIncome, vendorPayments, inputTaxClaimable, config }`.
- [ ] **Step 2:** Implement an initial, real catalog (expandable — this is data):
  - `DEPRECIATION_UNCLAIMED` — asset acquired this FY with no depreciation expense booked → saving = provisionRate × first-year depreciation. legalRef: "Income Tax Ordinance 2001, s.22 & 3rd Schedule". risk: safe.
  - `ADVANCE_TAX_OVERPAID` — advance tax paid YTD > provisionRate × projectedAnnualIncome → saving = excess; legalRef "ITO 2001, s.147; Form 147". risk: review.
  - `INPUT_TAX_UNCLAIMED` — eligible input GST on purchases not offset → saving = unclaimed input; legalRef "Sales Tax Act 1990, s.7". risk: safe.
  - `WHT_SECTION_OPTIMISATION` — payments under a higher-rate section that qualify for a lower one → saving = rate delta × base; legalRef "ITO 2001, s.153 vs s.235A". risk: review.
- [ ] **Step 3:** Unit-test each `detect` with crafted `ctx` (positive + negative cases).
- [ ] **Step 4:** Run `npm run test:unit -- taxOptimizationRules` → PASS. Commit `feat(tax): optimization rule catalog`.

### Task 5.2: Advisor service + context builder + endpoint

**Files:**
- Create: `services/taxAdvisor.service.js`
- Modify: `controllers/tax.controller.js`, `routes/v1/tax.routes.js`
- Modify frontend: `tax.service.js`, `useTax.js`
- Test: `tests/integration/taxAdvisor.service.test.js`

- [ ] **Step 1:** `buildContext(businessId)` — assemble `ctx` from existing repos (fixed-asset accounts, advance-tax ledger, forecast/projected income from the AI forecast or simple annualised YTD, input-tax account, vendor payments).
- [ ] **Step 2:** `getAdvisories(businessId)` — run every catalog rule over `ctx`, return sorted-by-saving array `[{ id, taxType, title, explanation, legalRef, estimatedSavingPKR, riskLevel, actionLink }]`. Every item MUST carry `legalRef` + `estimatedSavingPKR` (AC). `riskLevel:'review'` items get a `riskWarning` string (AC: no aggressive position without prominent warning).
- [ ] **Step 3:** Add `GET /tax/advisories` (controller + route). Frontend `getAdvisories`, `useTaxAdvisories()`.
- [ ] **Step 4:** Integration test: a business with an undepreciated asset surfaces `DEPRECIATION_UNCLAIMED` with a non-zero saving + the legal ref. Run → PASS. Commit `feat(tax): optimization advisor service + endpoint`.

---

## Phase 6 — Advisories UI + Needs-Attention integration (FR-04.2 UI)

### Task 6.1: Advisories list on the Tax Autopilot page

**Files:**
- Create: `src/components/tax/AdvisoryCard.jsx`
- Modify: `src/pages/tax/TaxAutopilotPage.jsx`

- [ ] **Step 1:** `AdvisoryCard`: plain-language title + estimated saving badge ("Save ~Rs 180,000"), one-line explanation, an expandable "Legal basis" (shows `legalRef`), and a `riskWarning` banner styled with `var(--c-negative)` when `riskLevel==='review'`. Primary action = `actionLink`.
- [ ] **Step 2:** Render an "Ways to pay less tax" section on `TaxAutopilotPage` from `useTaxAdvisories()`; empty state "No optimizations found — your tax setup looks efficient."
- [ ] **Step 3:** Build + preview across a dark theme + Daybreak. Commit `feat(tax): advisories UI`.

### Task 6.2: Surface top advisory in the dashboard Needs-Attention feed

**Files:** Modify `src/components/dashboard/NeedsAttentionFeed.jsx` (or the `/ai/needs-attention` backend merge) to include the highest-saving advisory.

- [ ] **Step 1:** Prefer backend: in the `needs-attention` aggregator, include the top tax advisory as a `level:'info'` item ("Save Rs X — claim depreciation on the March vehicle") linking to `/tax`. If that aggregator is server-side, add there; else add a client merge in `NeedsAttentionFeed`.
- [ ] **Step 2:** Verify it appears on the dashboard. Commit `feat(tax): top advisory in needs-attention feed`.

---

## Phase 7 — Return data model + builders (FR-04.3 core)

### Task 7.1: TaxReturn model + repository

**Files:**
- Create: `models/taxReturn.model.js`, `repositories/taxReturn.repository.js`
- Create: `config/constants.js` addition — `RETURN_TRANSITIONS` (draft→validated→submitted→filed; any→rejected) using the existing state-machine helper pattern.
- Test: `tests/unit/taxReturn.model.test.js`

- [ ] **Step 1:** Model: `{ businessId, returnType ('GST-01'|'WHT-165'|'IT-RETURN'|'EOBI'|'SESSI'), period ({ year, month? }), status, data (Mixed — mapped FBR fields), validation ({ passed, errors:[{code,field,message,fix}] }), fbr ({ ackNumber, submittedAt, mode }), exportPath, createdBy }`. Indexes `{ businessId, returnType, 'period.year', 'period.month' }`.
- [ ] **Step 2:** Add `RETURN_TRANSITIONS` + static `canTransition(from,to)` mirroring `PO_TRANSITIONS` in `config/constants.js`.
- [ ] **Step 3:** Repo extends `BaseRepository`; `findByPeriod(businessId, returnType, period)`.
- [ ] **Step 4:** Unit-test transitions (valid + invalid). Run → PASS. Commit `feat(tax): TaxReturn model + state machine`.

### Task 7.2: GST-01 builder (+ Annex A/B/C)

**Files:**
- Create: `services/returnBuilders/gst01.builder.js`
- Test: `tests/integration/gst01.builder.test.js`

- [ ] **Step 1:** `buildGST01(businessId, period)` reads the tax ledger (reuse `taxReport.service.js` summary/ledger for that month) and maps to GST-01 fields: total taxable sales, output tax (Annex-C: invoice-wise sales), taxable purchases, input tax (Annex-A: invoice-wise purchases), net payable/refundable. Return `{ fields, annexes: { A, B, C } }` matching FBR GST-01 structure.
- [ ] **Step 2:** Integration test: seed a month of sales+purchases; assert output/input/net match the tax ledger and Annex-C line count == number of taxable sales.
- [ ] **Step 3:** Run → PASS. Commit `feat(tax): GST-01 + annex builder`.

### Task 7.3: WHT statement + income-tax return builders

**Files:**
- Create: `services/returnBuilders/wht165.builder.js`, `services/returnBuilders/itReturn.builder.js`
- Test: `tests/integration/returnBuilders.test.js`

- [ ] **Step 1:** `buildWHT165(businessId, period)` — per-vendor WHT deducted (reuse `/reports/wht`), mapped to the 165 statement format (vendor NTN/CNIC, section, gross, tax withheld).
- [ ] **Step 2:** `buildITReturn(businessId, fiscalYear)` — pull income statement + balance sheet + the income-tax provision; map to the IT return wrapper (income from business, taxable income, tax chargeable, advance tax adjusted, balance payable).
- [ ] **Step 3:** Integration tests for both against seeded data. Run → PASS. Commit `feat(tax): WHT-165 + income-tax return builders`.

### Task 7.4: Prepare endpoint (compile → persist draft)

**Files:** Modify `controllers/tax.controller.js`, `routes/v1/tax.routes.js`; create `services/returnPrepare.service.js`

- [ ] **Step 1:** `returnPrepare.service.prepare(businessId, returnType, period)` → pick the builder by `returnType`, build `data`, upsert a `TaxReturn` (status `draft`).
- [ ] **Step 2:** Routes: `GET /tax/returns`, `POST /tax/returns/prepare` (body `{returnType, period}`), `GET /tax/returns/:id`. Controllers thin → service.
- [ ] **Step 3:** Integration test: prepare GST-01 → a draft return persists with mapped fields. Run → PASS. Commit `feat(tax): return prepare endpoint`.

---

## Phase 8 — Pre-filing validation + FBR rejection rules (FR-04.3 validation)

### Task 8.1: FBR rejection-rule catalog

**Files:**
- Create: `config/fbrRejectionRules.js`
- Test: `tests/unit/fbrRejectionRules.test.js`

- [ ] **Step 1:** Rule shape `{ code, returnType, field, message, fix, check(returnData) → boolean (true = violation) }`. Seed a real, expandable set (target ≥95% of common rejections — this catalog is the lever):
  - `NTN_MISSING` / `NTN_FORMAT` — business or counterparty NTN absent/malformed.
  - `OUTPUT_LT_ANNEX` — header output tax ≠ Σ Annex-C lines.
  - `INPUT_LT_ANNEX` — header input tax ≠ Σ Annex-A lines.
  - `NEGATIVE_LIABILITY_NO_REFUND_FLAG` — net negative without refund election.
  - `PERIOD_NOT_CLOSED` — filing a period with unposted/draft journals.
  - `WHT_VENDOR_CNIC_MISSING` — 165 line without NTN/CNIC.
  - `ZERO_RATED_NO_EVIDENCE` — zero-rated sale missing required annex field.
- [ ] **Step 2:** Unit-test each rule (violating + clean sample). Run → PASS. Commit `feat(tax): FBR rejection-rule catalog`.

### Task 8.2: Validator service + endpoint

**Files:** Create `services/returnValidator.service.js`; modify controller/routes; frontend client+hook.

- [ ] **Step 1:** `validate(returnDoc)` runs all rules for `returnDoc.returnType`, returns `{ passed, errors:[{code,field,message,fix}] }`; persists onto the return + transitions `draft→validated` when `passed`.
- [ ] **Step 2:** `POST /tax/returns/:id/validate`. Frontend `validateReturn(id)` + `useValidateReturn()`.
- [ ] **Step 3:** Integration test: a return with mismatched annex totals fails with `OUTPUT_LT_ANNEX` and a `fix` string. Run → PASS. Commit `feat(tax): pre-filing validator`.

---

## Phase 9 — FBR submission adapter + XML/PDF export + audit (FR-04.3 filing)

### Task 9.1: FBR-compatible XML exporter (guaranteed path)

**Files:**
- Add dep: `xmlbuilder2`. Create `services/fbr/fbrXmlExporter.js`
- Test: `tests/unit/fbrXmlExporter.test.js`

- [ ] **Step 1:** `toXML(returnDoc)` → FBR IRIS-compatible XML for the return type (GST-01 element tree with Annex nodes; WHT statement tree; IT return tree). Return a string.
- [ ] **Step 2:** Unit-test: valid XML, contains header totals + the right number of annex line nodes; parses with an XML parser.
- [ ] **Step 3:** Run → PASS. Commit `feat(tax): FBR XML exporter`.

### Task 9.2: FBR client adapter (IRIS, pluggable) + export route

**Files:**
- Create: `services/fbr/fbrClient.service.js`
- Modify: controller/routes; create PDF render reusing the existing export/PDF util.
- Test: `tests/integration/fbrClient.test.js` (mock HTTP)

- [ ] **Step 1:** `fbrClient.submit(returnDoc, config)` — if `config.filingMode==='iris'` and credentials present, POST the XML to IRIS and return `{ ackNumber }`; on any failure or `filingMode==='xml'`, fall back to `{ mode:'xml', export: toXML(...) }`. Network calls behind a 1-place adapter so it's mockable/swappable (AC: graceful when FBR unavailable).
- [ ] **Step 2:** Routes: `POST /tax/returns/:id/submit` (→ submit; on IRIS ack: transition `validated→submitted→filed`, store `fbr.ackNumber`, `auditService.log` the ack; on xml fallback: store `exportPath`, status stays `validated`, return the file). `GET /tax/returns/:id/export?format=xml|pdf`.
- [ ] **Step 3:** Integration test with mocked IRIS success (ack stored + audit row) and mocked failure (XML fallback returned, no crash).
- [ ] **Step 4:** Run → PASS. Commit `feat(tax): FBR submission adapter + xml/pdf export + audit ack`.

---

## Phase 10 — Return-filing wizard UI + returns queue (FR-04.3 UI)

### Task 10.1: Returns queue

**Files:** Create `src/components/tax/ReturnsQueue.jsx`; modify `TaxAutopilotPage.jsx`; frontend client+hooks for returns.

- [ ] **Step 1:** Add `tax.service` methods: `listReturns`, `prepareReturn`, `getReturn`, `validateReturn`, `submitReturn`, `exportReturn`; hooks in `useTax.js`.
- [ ] **Step 2:** `ReturnsQueue`: rows per upcoming/active return — type, period, status pill (draft/validated/submitted/filed/rejected), deadline countdown, primary CTA ("Prepare" → "Review & File"). Render on `TaxAutopilotPage`.
- [ ] **Step 3:** Build + preview. Commit `feat(tax): returns queue UI`.

### Task 10.2: One-click filing wizard

**Files:** Create `src/components/tax/ReturnFilingWizard.jsx` (modal/drawer)

- [ ] **Step 1:** Steps: **Review** (rendered return summary, plain-language "You'll file Rs X GST for May") → **Checks** (validation results; each error shows its `fix`; block "File" until passed) → **File** (single confirm → `submitReturn`; show ack number on success, or "Download FBR XML" if in xml mode). One primary button per step; back/cancel always available.
- [ ] **Step 2:** Non-expert affordances: each section has a one-line "what this means"; expert affordance: "View full annexes" toggle + link to the tax ledger. Accessibility: focus trap, Escape to close.
- [ ] **Step 3:** Wire from `ReturnsQueue` CTA. Build + preview 375px/desktop, dark + Daybreak. Commit `feat(tax): one-click return filing wizard`.

---

## Phase 11 — Scheduler + reminders (autopilot)

### Task 11.1: Auto-prepare N days before deadline

**Files:** Modify `server.js` (cron); reuse `returnPrepare`, `returnValidator`, the filing calendar; notifications via the existing toast/needs-attention or email if present.

- [ ] **Step 1:** Daily cron: for each tax-enabled business, for each calendar obligation whose `daysRemaining === config.autoPrepareDaysBefore`, auto-`prepare` + `validate` the return (idempotent: skip if a return for that period already exists past `draft`).
- [ ] **Step 2:** Emit a needs-attention/notification "Your {label} for {period} is prepared and ready to review — due in {n} days."
- [ ] **Step 3:** Manual verify by setting `autoPrepareDaysBefore` to match a near deadline; confirm a draft+validated return appears. Commit `feat(tax): auto-prepare returns before deadline`.

---

## Phase 12 — End-to-end acceptance verification

### Task 12.1: Acceptance walkthrough (preview + assertions)

- [ ] **FR-04.1:** Post a taxable sale → within 10s the position endpoint + homepage widget reflect the new GST liability (verify via the invalidation wired in Task 1.2). GST net matches the tax ledger with zero variance on a standard transaction. Tax widget present on the dashboard homepage. WHT auto-JE present on a qualifying payment.
- [ ] **FR-04.2:** Every advisory shows a legal provision + PKR saving; a `review`-risk advisory shows a prominent risk warning; no `review` item lacks one.
- [ ] **FR-04.3:** Prepare a GST-01 with zero manual entry; introduce a mismatch → validator flags it with a fix; submit in xml mode → FBR-compatible XML downloads; submit in iris mode (mocked) → ack number stored in the audit trail.
- [ ] **Step:** Record results; fix any gaps; final commit `test(tax): FR-04 acceptance verified`.

---

## Self-review — spec coverage map

| Spec item | Phase / Task |
|---|---|
| FR-04.1 GST output−input per posting | reuse Phase 5.4 engine; read model Task 1.1 |
| FR-04.1 WHT tracked per payment | Task 3.2 (verify/implement auto-JE) |
| FR-04.1 Income-tax provision continuous | Task 3.1 |
| FR-04.1 EOBI/SESSI per payroll | Task 3.3 (flag-gated) |
| FR-04.1 live dashboard per tax type + countdown + 6-mo trend | Tasks 1.1, 2.x, 4.1 |
| FR-04.1 AC ≤10s update | Task 1.2 (invalidate `['tax']` on txn mutations) |
| FR-04.1 AC GST matches FBR rules zero variance | Task 1.1 reuses engine; Task 12 verify |
| FR-04.1 AC visible on homepage | Task 4.2 |
| FR-04.2 advisories with legal ref + PKR saving | Tasks 5.1, 5.2 |
| FR-04.2 AC risk warning on uncertain positions | Task 5.2 (`riskLevel:'review'` + `riskWarning`), 6.1 |
| FR-04.2 surfaced not buried | Tasks 6.1, 6.2 |
| FR-04.3 auto-compile from GL, zero manual entry | Tasks 7.2–7.4 |
| FR-04.3 map to FBR formats (GST-01/Annex/WHT/IT) | Tasks 7.2, 7.3, 9.1 |
| FR-04.3 pre-filing validation ≥95% rejections | Tasks 8.1, 8.2 |
| FR-04.3 one-click submit + single confirm | Tasks 10.2, 9.2 |
| FR-04.3 ack stored in audit trail | Task 9.2 |
| FR-04.3 XML fallback when IRIS unavailable | Tasks 9.1, 9.2 |
| FR-04.3 auto-prepare 5 days before | Task 11.1 |

**Decomposition note:** FR-04.1 (Phases 1–4), FR-04.2 (Phases 5–6), and FR-04.3 (Phases 7–11) are independently shippable. If executing incrementally, ship FR-04.1 first (highest daily value, lowest external dependency), then FR-04.2, then FR-04.3 (the only part with an external FBR dependency, de-risked by the XML-first design).

**Open items to confirm during execution (not blockers):** exact tax-account codes/names in `taxEngine.service.js`; whether config lives on a `TaxConfig` model or `Business`; whether a payroll/employee model already exists; the precise FBR GST-01/165/IT XML schemas (start from the published FBR IRIS schema; the builder/exporter structure is schema-agnostic and the field map is the only thing to finalize).

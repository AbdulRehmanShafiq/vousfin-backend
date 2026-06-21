# Phase 5 — Statement of Changes in Equity + Custom Report Builder + IFRS-15 Notes

**SRS:** FR-02.4 (Statement of Changes in Equity), FR-02.5 (custom/comparative report builder + scheduled delivery), IFRS-15 revenue disclosure notes.
**Date:** 2026-06-21
**Status:** Design approved (user delegated final calls — "do what's best for market competition").

---

## 1. Goal

Close the last three reporting gaps in the SRS FR-02 group, in a way that is a genuine
market differentiator for VousFin against QuickBooks/Xero/Zoho for SME + IFRS-needing
businesses:

1. A **professional, multi-column Statement of Changes in Equity** that provably
   reconciles to the Balance Sheet.
2. A **custom Report Builder** — users assemble their own P&L / Balance Sheet / blank
   layouts, add comparative (prior-period / prior-year) columns with absolute + %
   variance, filter by cost centre, and **schedule automatic email delivery** (daily /
   weekly / monthly) as PDF.
3. **IFRS-15 revenue notes** — auto-generated revenue disaggregation + plain-language
   accounting-policy text, every figure grounded in the GL.

All copy is plain-language (non-accountant owners), no new backend or frontend
dependencies, all figures traceable to the ledger.

---

## 2. Context — what already exists (build ON this)

- `services/report.service.js` — Income Statement, Balance Sheet, Cash Flow, Trial
  Balance, GL, Aging, Tax, Comparative, KPI. All cached via `utils/reportCache.js`,
  all read balances through the private `_getBalancesAsOf(businessId, asOfDate)` helper
  and `transactionRepository.getDebitCreditTotals[Between]`.
  - **Balance Sheet equity logic (the anchor for FR-02.4):** the BS derives a *synthetic*
    "Current Year Earnings" equity line = economic(Revenue) − economic(Expense) +
    economic(real "Current Year Earnings" account), and **excludes** any real account
    literally named "Current Year Earnings" from the listed equity accounts. Section
    totals use each account's `normalBalance` to sign the contribution (a debit-normal
    account such as Drawings *reduces* equity). The Statement of Changes in Equity MUST
    mirror this exactly so it foots to `BS.totalEquity` by construction.
- `services/fiscalYear.service.js` — source of equity *movements*: closing entries
  (net income → Retained Earnings), opening balances, drawings/capital flows.
- `config/constants.js` `DEFAULT_ACCOUNTS` equity accounts:
  `3110 Capital / Investment` (Credit), `3120 Distributions / Drawings` (Debit),
  `3130 Share Premium` (Credit), `3140 Revaluation Reserve` (Credit),
  `3210 Retained Earnings` (Credit), `3310 Current Year Earnings` (Credit).
- Infra the builder + scheduling reuse: `jobs/` directory with node-cron jobs registered
  in `server.js`; `utils/email.utils.js` mailer; `services/cfoReport.service.js` PDF
  renderer; `services/invoiceScheduler.service.js` + `models/InvoiceSchedule.model.js`
  as the scheduled-delivery precedent; `utils/pdfExport.utils.js` +
  `utils/excelExport.utils.js` exporters; `repositories/base.repository.js`.
- Frontend page pattern: `src/pages/reports/BalanceSheetPage.jsx`, `@/hooks/useReports`,
  `@/components/ui/ExportButton`, `@/utils/formatters.formatCurrency`,
  `@/stores/useBusinessStore`. Reports routes + nav config. **No dnd-kit** (21 deps total).

**Jest gotcha (from prior phases):** tests live under `tests/unit/<layer>/` and
`tests/integration/`. The `__tests__/` directory exists but jest **ignores** it
(`testMatch: ["**/tests/**/*.test.js"]`).

---

## 3. Component A — Statement of Changes in Equity (FR-02.4)

### 3.1 Approach

Mirror the Balance Sheet's equity construction so the statement reconciles by
construction (not by a fudge factor).

- **Columns** = each real equity account, EXCEPT any account literally named
  "Current Year Earnings" (same exclusion the BS uses), PLUS one **synthetic
  "Current Year Earnings"** column.
- **Opening** balance per column = economic balance at `startDate − 1 day`.
  **Closing** per column = economic balance at `endDate`. Both computed with the SAME
  logic the BS uses, so `Σ columns = BS.totalEquity` at each date.
  - real-account column economic value: `_getBalancesAsOf` value signed by
    `normalBalance` so a debit-normal account (Drawings) presents as negative.
  - synthetic CYE column = `economic(Revenue ≤ date) − economic(Expense ≤ date) +
    economic(real "Current Year Earnings" account ≤ date)`.
- **Movement rows** (each sums per-column to `Closing − Opening`):
  1. **Profit for the period** — `economic(Revenue) − economic(Expense)` over
     `[startDate, endDate]` (equals Income Statement net income); placed in the
     synthetic CYE column.
  2. **Owner / capital contributions** — period net credit movement on Capital (3110)
     + Share Premium (3130) accounts (classified by name/code regex, tolerant of
     renames).
  3. **Owner draws / dividends** — period net debit movement on Distributions /
     Drawings (3120); presented negative.
  4. **Other changes** — the **residual per column** = `(Closing − Opening) −
     row1 − row2 − row3` for that column. This guarantees each column foots
     Opening→Closing exactly and absorbs year-end RE↔CYE transfers (which net to ~0
     across columns), revaluation-reserve moves, and opening-balance entries.

### 3.2 Output shape

```js
{
  components: [
    { key: 'capital',            label: 'Owner capital',         accountIds: [...] },
    { key: 'sharePremium',       label: 'Share premium',         accountIds: [...] },
    { key: 'revaluation',        label: 'Revaluation reserve',   accountIds: [...] },
    { key: 'retainedEarnings',   label: 'Retained earnings',     accountIds: [...] },
    // ...any other real equity accounts grouped under 'other'...
    { key: 'currentYearEarnings',label: 'Current year earnings', isDerived: true },
  ],
  rows: [
    { key: 'opening',       label: 'Balance at start',           values: { <componentKey>: number }, total },
    { key: 'profit',        label: 'Profit for the period',      values: {...}, total },
    { key: 'capital',       label: 'Money put in by owners',     values: {...}, total },
    { key: 'distributions', label: 'Money taken out / dividends',values: {...}, total },
    { key: 'other',         label: 'Other changes',              values: {...}, total },
    { key: 'closing',       label: 'Balance at end',             values: {...}, total },
  ],
  reconciliation: { closingTotal, balanceSheetEquity, reconciles: boolean, difference },
  period: { startDate, endDate },
}
```

Labels are plain-language; an optional `accountingLabel` may carry the formal term.

### 3.3 Files

- **Modify** `services/report.service.js` — add `getStatementOfChangesInEquity(businessId,
  startDate, endDate)` (cached as `equity-statement`). Add a private helper
  `_economicEquityByAccount(map, accounts)` reused for opening/closing.
- **Modify** `controllers/report.controller.js` — `getStatementOfChangesInEquity` handler
  (uses `toStartOfDay`/`toEndOfDay`/`resolveReportDates`). Add `equity` case to
  `exportReport`.
- **Modify** `routes/v1/report.routes.js` — `GET /equity` with validation.
- **Modify** `validations/report.validation.js` — `equityStatementSchema` (startDate,
  endDate).
- **Modify** `utils/pdfExport.utils.js` — `generateEquityStatementPDF(...)`.
- **Modify** `utils/excelExport.utils.js` — `equityStatement` case.
- **Frontend create** `src/pages/reports/EquityStatementPage.jsx` (mirror BalanceSheetPage:
  date range, KPI strip, matrix table, reconciliation badge, CSV via ExportButton, PDF via
  export endpoint).
- **Frontend modify** `@/hooks/useReports` — `useEquityStatement`; report frontend service;
  reports routes + nav.

### 3.4 Acceptance

`Closing Equity = Opening + Net Profit − Drawings/Dividends ± Other`, and
`reconciliation.reconciles === true` (`closingTotal === BS.totalEquity(endDate)` within
0.01). Profit row total === Income Statement net income for the period.

---

## 4. Component B — Custom Report Builder (FR-02.5)

### 4.1 Model — `models/ReportTemplate.model.js`

```js
{
  businessId: ObjectId (indexed),
  name: String (required),
  baseType: 'pl' | 'bs' | 'custom',
  layout: [{
    id: String,                 // stable client id
    kind: 'section' | 'account-group' | 'account' | 'subtotal' | 'spacer',
    label: String,
    accountType?: String,       // for account-group rows
    accountSubtype?: String,
    accountIds?: [ObjectId],    // for explicit account rows
    metric: 'balance' | 'flow', // point-in-time vs period movement
    visible: Boolean,
  }],
  filters: { costCenterId?: ObjectId },
  comparative: {
    enabled: Boolean,
    mode: 'prior-period' | 'prior-year' | 'custom',
    priorStart?: Date, priorEnd?: Date,
  },
  schedule: {
    enabled: Boolean,
    frequency: 'daily' | 'weekly' | 'monthly',
    dayOfWeek?: Number,   // 0-6 for weekly
    dayOfMonth?: Number,  // 1-28 for monthly
    hour: Number,         // 0-23, default 6
    recipients: [String], // emails
    format: 'pdf',
    lastRunAt?: Date, nextRunAt?: Date,
  },
  createdBy: ObjectId,
  timestamps: true,
}
```

### 4.2 Repository — `repositories/reportTemplate.repository.js`

Extends `BaseRepository`. Adds: `findOwned(businessId)`, `findOwnedById(businessId, id)`,
`findScheduledDue(now)` (`schedule.enabled === true && schedule.nextRunAt <= now`).

### 4.3 Service — `services/reportBuilder.service.js`

- `renderTemplate(businessId, templateId, { startDate, endDate, asOfDate })`:
  1. Load template (owned).
  2. Resolve dates: `flow` rows use `[startDate, endDate]`; `balance` rows use
     `asOfDate` (default endDate). Comparative: prior-period = immediately preceding
     equal-length window; prior-year = same window − 1 year; custom = `priorStart/End`.
  3. Fetch once: current balances via `report.service._getBalancesAsOf` (export the
     helper or add a thin public `getBalancesAsOf`), period flows via
     `transactionRepository.getDebitCreditTotalsBetween`, and the comparative set if
     enabled. (Cost-centre-scoped filtering is **deferred** — see Non-goals; the
     `filters.costCenterId` field is retained on the model for forward-compat but is
     not applied in this phase and no UI exposes it.)
  4. Assemble rows in `layout` order; subtotal rows sum preceding sibling rows;
     per row compute `{ current, prior?, change?, changePct? }`.
  5. Return `{ template:{id,name,baseType,comparative}, columns, rows, period, generatedAt }`.
  - In-memory assembly over 1–3 aggregate queries → **< 5s** budget (FR-02.5).
- `previewLayout(businessId, layoutPayload, dateOpts)` — same render against an unsaved
  layout (validates the layout shape, does not persist).
- `defaultLayoutFor(baseType, accounts)` — seed a starter layout from the chart of
  accounts so "New P&L" / "New Balance Sheet" open pre-filled.

### 4.4 Controller / routes — `report.routes.js` (+ a `reportTemplate.controller.js`)

- `GET    /reports/templates`            list owned
- `POST   /reports/templates`            create
- `GET    /reports/templates/:id`        get one
- `PUT    /reports/templates/:id`        update (name/layout/filters/comparative)
- `DELETE /reports/templates/:id`        delete
- `POST   /reports/templates/:id/render` render saved (body: dates)
- `POST   /reports/templates/preview`    render unsaved layout
- `PUT    /reports/templates/:id/schedule` set/clear schedule (computes `nextRunAt`)
- `GET    /reports/templates/:id/export?format=pdf|csv`  download

Validation in `validations/reportTemplate.validation.js` (Joi). Routes mount on the
existing reports router; `authMiddleware + requireBusiness` already applied there.

### 4.5 Scheduled delivery — `jobs/scheduledReport.job.js`

- node-cron, hourly tick (mirrors job style in `server.js`).
- `reportTemplate.repository.findScheduledDue(new Date())` → for each: render →
  `cfoReport`/`pdfExport` PDF → `email.utils` send to `recipients` → update
  `lastRunAt = now`, `nextRunAt = computeNextRun(schedule, now)`.
- `computeNextRun(schedule, from)` pure helper (unit-tested): daily → next day at
  `hour`; weekly → next `dayOfWeek` at `hour`; monthly → next `dayOfMonth` at `hour`.
- Register in `server.js` alongside existing cron jobs. Failures log + continue (one bad
  template never blocks the rest).

### 4.6 Frontend — `src/pages/reports/ReportBuilderPage.jsx`

- **List view**: saved templates as cards (name, base type, schedule badge), "New report"
  → base picker (P&L / Balance Sheet / Blank).
- **Builder**: ordered row list with **Move up / Move down** buttons + **show/hide**
  toggle + "Add account group" / "Add account" / "Add subtotal" / "Add spacer". No
  drag library (keyboard-accessible, lean deps).
- Comparative toggle (None / Prior period / Prior year), cost-centre filter (reuse cost
  centre list), live **Preview** (calls `/preview` or `/:id/render`), **Save**,
  **Schedule** dialog (frequency + day + recipients), **Export PDF / CSV**.
- New `useReportTemplates` hooks (TanStack Query), report frontend service additions,
  routes `/reports/builder` and `/reports/builder/:id`, nav entry under Reports. Plain
  language throughout.

### 4.7 Acceptance

Custom reports render < 5s. Comparative columns show absolute and % differences. Reports
schedulable daily / weekly / monthly with auto-email (each run renders the period implied
by its frequency: daily → previous day, weekly → previous 7 days, monthly → previous
calendar month). Layout reorder + show/hide persists. (Cost-centre-scoped filtering is
deferred to a later phase — see Non-goals.)

---

## 5. Component C — IFRS-15 Revenue Notes (pragmatic, GL-grounded)

### 5.1 Service — add to `services/report.service.js`

`getRevenueNotes(businessId, startDate, endDate)` (cached as `revenue-notes`):

- **Disaggregation of revenue**: economic credit movement on Revenue-type accounts over
  the period, grouped by account (revenue stream); each `{ stream, amount, pct }`;
  `totalRevenue`.
- **Accounting-policy note**: plain-language IFRS-15 five-step summary text, referencing
  the period's `totalRevenue` and disaggregation. Static template, no LLM (deterministic,
  audit-safe).
- Output `{ policyText, disaggregation:[...], totalRevenue, period }`.

### 5.2 Route / frontend

- `GET /reports/notes/revenue` (+ validation reusing the income-statement date schema).
- Surface as a collapsible **"Revenue notes (IFRS 15)"** panel on
  `src/pages/reports/IncomeStatementPage.jsx`; `useRevenueNotes` hook.

### 5.3 Acceptance

Disaggregation totals equal Income Statement revenue for the period; policy text renders
with figures filled in; panel is collapsible and exports with the income statement.

---

## 6. Cross-cutting

- All new report reads use `reportCache` (already invalidated on ledger changes via
  `reportCache.invalidate(businessId)`).
- **No new backend or frontend dependencies.**
- TDD per writing-plans. New tests under `tests/unit/services/`,
  `tests/unit/repositories/`, `tests/unit/jobs/`. Key tests:
  - equity reconciliation (column footing + `Σ = BS equity` + profit = net income),
  - report builder render + comparative variance (absolute + %),
  - `computeNextRun` for daily/weekly/monthly,
  - revenue-notes disaggregation = income-statement revenue.
- Plain-language labels (per product-copy plain-language rule).
- Reuse existing helpers; do not duplicate balance logic — extend `report.service`.

---

## 7. Non-goals (explicit scope guards)

- No full IFRS-15 contract-balance / performance-obligation / remaining-PO disclosures
  (needs contract tracking the GL doesn't have).
- No drag-and-drop builder (lightweight reorder instead).
- No new charting; the builder renders tabular reports (with comparative columns).
- No multi-format scheduled delivery beyond PDF in this phase (CSV is on-demand only).
- No cost-centre-scoped report-builder filtering in this phase (niche power-user
  feature; the `filters.costCenterId` field is kept on the model for forward-compat
  but is not applied and no UI exposes it). Revisit when there is demand.

# Equity Statement + Report Builder + IFRS-15 Notes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Statement of Changes in Equity (FR-02.4), a custom/comparative Report Builder with scheduled email delivery (FR-02.5), and IFRS-15 revenue disclosure notes — all grounded in the existing GL.

**Architecture:** Extend `report.service.js` for the equity statement and revenue notes (reusing its `_getBalancesAsOf` economic-balance logic so the equity statement reconciles to the Balance Sheet by construction). Add a `ReportTemplate` model + repository + `reportBuilder.service.js` that renders saved layouts against the GL with comparative variance, plus a `scheduledReport` cron job mirroring the existing job pattern. Frontend adds three React pages following the `BalanceSheetPage` pattern with no new dependencies.

**Tech Stack:** Node.js / Express / Mongoose / Joi / node-cron / Jest (backend); React 19 / Vite / TanStack Query / Tailwind (frontend).

## Global Constraints

- Backend commands run from `vousfin-backend-main/`; frontend from `vousfin-frontend-main/`.
- **No new backend or frontend dependencies.** Frontend stays at 21 deps; reorder UI uses move-up/down buttons, not a drag library.
- Tests live under `tests/unit/<layer>/` and `tests/integration/`. Jest **ignores** `__tests__/` (`testMatch: ["**/tests/**/*.test.js"]`). Run a single test file with `npx jest <path> -t "<name>"` or `npx jest <path>`.
- Layer pattern: `controller → service → repository → model`. Controllers are thin and call `ApiResponse.success(res, data, msg)`; services throw `ApiError(status, msg)`; repositories extend `BaseRepository`.
- Report reads go through `utils/reportCache.js` (`reportCache.get(type, businessId, params)` / `reportCache.set(...)`); it is already invalidated on ledger changes.
- All user-facing copy is plain-language for non-accountant owners (no accounting jargon as the primary label).
- Reports router (`routes/v1/report.routes.js`) already applies `authMiddleware + requireBusiness`; `req.user.businessId` and `req.user.id` are available.
- Money: round to 2dp with `Math.round(v * 100) / 100`.
- Commit after each task with a `feat:`/`test:` message ending with the Co-Authored-By trailer (see Task 1 Step 5).

---

## File Structure

**Backend — create**
- `services/reportBuilder.service.js` — render saved/preview report templates against the GL with comparative variance; seed default layouts.
- `models/ReportTemplate.model.js` — saved report layout + filters + comparative + schedule.
- `repositories/reportTemplate.repository.js` — owned-scoped queries + `findScheduledDue`.
- `controllers/reportTemplate.controller.js` — template CRUD + render/preview/schedule/export handlers.
- `validations/reportTemplate.validation.js` — Joi schemas for template body + render dates.
- `jobs/scheduledReport.job.js` — hourly cron: render due templates, email PDF, advance `nextRunAt`. Exports `computeNextRun` (pure) + `scheduleReportDelivery`.

**Backend — modify**
- `services/report.service.js` — add `getStatementOfChangesInEquity`, `getRevenueNotes`, and a public `getBalancesAsOf` wrapper around `_getBalancesAsOf`.
- `controllers/report.controller.js` — add `getStatementOfChangesInEquity`, `getRevenueNotes`; add `equity` case to `exportReport`.
- `routes/v1/report.routes.js` — `GET /equity`, `GET /notes/revenue`, and mount template routes.
- `validations/report.validation.js` — `equityStatementSchema`, `revenueNotesSchema`; add `'equity'` to `exportReportSchema` type enum.
- `utils/pdfExport.utils.js` — `generateEquityStatementPDF`.
- `utils/excelExport.utils.js` — `equityStatement` case.
- `utils/email.utils.js` — pass `options.attachments` through to `mailOptions`.
- `server.js` — register `scheduleReportDelivery()` with the other jobs.

**Frontend — create**
- `src/pages/reports/EquityStatementPage.jsx`
- `src/pages/reports/ReportBuilderPage.jsx`

**Frontend — modify**
- `src/hooks/useReports.js` — `useEquityStatement`, `useRevenueNotes`, and report-template hooks.
- `src/services/*` report service — equity / notes / template API calls.
- `src/pages/reports/IncomeStatementPage.jsx` — collapsible "Revenue notes (IFRS 15)" panel.
- routes file + reports nav config — add Equity Statement + Report Builder entries.

---

## Task 1: Statement of Changes in Equity — service

**Files:**
- Modify: `services/report.service.js`
- Test: `tests/unit/services/report.equityStatement.test.js`

**Interfaces:**
- Consumes: `report.service._getBalancesAsOf(businessId, asOfDate)` → `{ [accountId]: number }` (economic balance signed by `normalBalance`); `accountRepository.findByBusiness(businessId)`; `transactionRepository.getDebitCreditTotalsBetween(businessId, startDate, endDate)` → `{ debitTotals:[{_id,total}], creditTotals:[{_id,total}] }`.
- Produces: `report.service.getStatementOfChangesInEquity(businessId, startDate, endDate)` → object in §3.2 of the spec; `report.service.getBalancesAsOf(businessId, asOfDate)` (public wrapper).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/services/report.equityStatement.test.js`:

```js
const reportService = require('../../../services/report.service');
const accountRepository = require('../../../repositories/account.repository');
const transactionRepository = require('../../../repositories/transaction.repository');

jest.mock('../../../repositories/account.repository');
jest.mock('../../../repositories/transaction.repository');

// Minimal chart: Capital (credit), Drawings (debit), Retained Earnings (credit),
// plus Revenue & Expense accounts that feed the synthetic Current Year Earnings.
const ACCOUNTS = [
  { _id: 'cap', accountCode: '3110', accountName: 'Capital / Investment', accountType: 'Equity', accountSubtype: 'Equity', normalBalance: 'Credit' },
  { _id: 'draw', accountCode: '3120', accountName: 'Distributions / Drawings', accountType: 'Equity', accountSubtype: 'Equity', normalBalance: 'Debit' },
  { _id: 're', accountCode: '3210', accountName: 'Retained Earnings', accountType: 'Equity', accountSubtype: 'Equity', normalBalance: 'Credit' },
  { _id: 'rev', accountCode: '4100', accountName: 'Sales Revenue', accountType: 'Revenue', accountSubtype: 'Revenue', normalBalance: 'Credit' },
  { _id: 'exp', accountCode: '6100', accountName: 'Operating Expense', accountType: 'Expense', accountSubtype: 'Operating Expenses', normalBalance: 'Debit' },
];

describe('getStatementOfChangesInEquity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    accountRepository.findByBusiness.mockResolvedValue(ACCOUNTS);
  });

  test('opening + movements foots to closing per column and reconciles to BS equity', async () => {
    const start = new Date('2026-01-01');
    const end = new Date('2026-12-31');

    // Economic balances: opening (day before start) vs closing (end).
    // Opening: capital 100000, drawings 0, RE 50000, rev/exp all-time 0 → CYE 0.
    // Closing: capital 120000 (owner put in 20000), drawings -15000 (took out 15000),
    //          RE 50000, rev 200000, exp 140000 → CYE = 200000 - 140000 = 60000.
    const openingMap = { cap: 100000, draw: 0, re: 50000, rev: 0, exp: 0 };
    const closingMap = { cap: 120000, draw: -15000, re: 50000, rev: 200000, exp: 140000 };

    jest.spyOn(reportService, '_getBalancesAsOf').mockImplementation(async (_b, d) =>
      new Date(d).getTime() < start.getTime() ? openingMap : closingMap
    );

    // Period movements: +20000 credit to capital, +15000 debit to drawings.
    transactionRepository.getDebitCreditTotalsBetween.mockResolvedValue({
      debitTotals: [{ _id: 'draw', total: 15000 }, { _id: 'exp', total: 140000 }],
      creditTotals: [{ _id: 'cap', total: 20000 }, { _id: 'rev', total: 200000 }],
    });

    const r = await reportService.getStatementOfChangesInEquity('biz1', start, end);

    const opening = r.rows.find(x => x.key === 'opening');
    const closing = r.rows.find(x => x.key === 'closing');
    const profit = r.rows.find(x => x.key === 'profit');

    // Per-column footing: opening + every movement row = closing
    for (const c of r.components) {
      const moves = r.rows
        .filter(x => !['opening', 'closing'].includes(x.key))
        .reduce((s, row) => s + (row.values[c.key] || 0), 0);
      expect(Math.round((opening.values[c.key] + moves) * 100) / 100)
        .toBeCloseTo(closing.values[c.key], 2);
    }

    // Profit row total equals net income (200000 - 140000)
    expect(profit.total).toBeCloseTo(60000, 2);

    // Opening total 150000 (100000 cap + 50000 RE), closing 215000 (120000 - 15000 + 50000 + 60000)
    expect(opening.total).toBeCloseTo(150000, 2);
    expect(closing.total).toBeCloseTo(215000, 2);

    // Reconciles to BS equity (Σ closing columns)
    expect(r.reconciliation.reconciles).toBe(true);
    expect(r.reconciliation.closingTotal).toBeCloseTo(215000, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/services/report.equityStatement.test.js`
Expected: FAIL — `reportService.getStatementOfChangesInEquity is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `services/report.service.js`, add a public wrapper and the new method inside the `ReportService` class (place after `getBalanceSheet`). The `_getBalancesAsOf` already returns each account's economic balance signed by `normalBalance`, so for a debit-normal equity account (Drawings) a positive draw yields a **negative** value — exactly how it should present in equity.

```js
  /** Public wrapper so other services (reportBuilder) can read balances. */
  async getBalancesAsOf(businessId, asOfDate) {
    return this._getBalancesAsOf(businessId, asOfDate);
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  STATEMENT OF CHANGES IN EQUITY  (FR-02.4)
  // ──────────────────────────────────────────────────────────────────────────
  async getStatementOfChangesInEquity(businessId, startDate, endDate) {
    if (!businessId || !startDate || !endDate)
      throw new ApiError(400, 'Missing required parameters: businessId, startDate, endDate');

    const cacheParams = {
      start: new Date(startDate).toISOString(),
      end:   new Date(endDate).toISOString(),
    };
    const cached = reportCache.get('equity-statement', businessId.toString(), cacheParams);
    if (cached) return cached;

    const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
    const openingDate = new Date(new Date(startDate).getTime() - 86400000);

    const [accounts, openMap, closeMap, movements] = await Promise.all([
      accountRepository.findByBusiness(businessId),
      this._getBalancesAsOf(businessId, openingDate),
      this._getBalancesAsOf(businessId, endDate),
      transactionRepository.getDebitCreditTotalsBetween(businessId, startDate, endDate),
    ]);

    const isCYE = (a) => /^current.?year.?earnings$/i.test((a.accountName || '').trim());
    const equityAccts = accounts.filter(a => a.accountType === 'Equity' && !isCYE(a));

    // Classify each real equity account into a component column.
    const classify = (a) => {
      const n = (a.accountName || '').toLowerCase();
      const c = a.accountCode || '';
      if (/capital|investment/.test(n) || c === '3110') return { key: 'capital', label: 'Owner capital' };
      if (/share premium/.test(n) || c === '3130')      return { key: 'sharePremium', label: 'Share premium' };
      if (/revaluation/.test(n) || c === '3140')        return { key: 'revaluation', label: 'Revaluation reserve' };
      if (/retained/.test(n) || c === '3210')           return { key: 'retainedEarnings', label: 'Retained earnings' };
      if (/distribution|drawing|dividend/.test(n) || c === '3120') return { key: 'capital', label: 'Owner capital' };
      return { key: 'other', label: 'Other equity' };
    };

    // Build ordered component list (only columns that have any account), + synthetic CYE.
    const compOrder = ['capital', 'sharePremium', 'revaluation', 'retainedEarnings', 'other'];
    const compLabels = {
      capital: 'Owner capital', sharePremium: 'Share premium', revaluation: 'Revaluation reserve',
      retainedEarnings: 'Retained earnings', other: 'Other equity',
    };
    const acctToComp = new Map();
    const compAccts = {};
    for (const a of equityAccts) {
      const { key } = classify(a);
      acctToComp.set(a._id.toString(), key);
      (compAccts[key] = compAccts[key] || []).push(a._id);
    }
    const components = compOrder
      .filter(k => compAccts[k])
      .map(k => ({ key: k, label: compLabels[k], accountIds: compAccts[k] }));
    components.push({ key: 'currentYearEarnings', label: 'Current year earnings', isDerived: true });

    // Economic sum over Revenue/Expense for the synthetic CYE column.
    const realCYE = accounts.filter(a => a.accountType === 'Equity' && isCYE(a));
    const econ = (map, type) => accounts
      .filter(a => a.accountType === type)
      .reduce((s, a) => s + (map[a._id.toString()] || 0), 0);
    const realCYEsum = (map) => realCYE.reduce((s, a) => s + (map[a._id.toString()] || 0), 0);
    const cyeAt = (map) => r2(econ(map, 'Revenue') - econ(map, 'Expense') + realCYEsum(map));

    // Per-component opening / closing from economic account balances.
    const colSum = (map, key) => r2((compAccts[key] || [])
      .reduce((s, id) => s + (map[id.toString()] || 0), 0));
    const opening = {}, closing = {};
    for (const c of components) {
      if (c.key === 'currentYearEarnings') { opening[c.key] = cyeAt(openMap); closing[c.key] = cyeAt(closeMap); }
      else { opening[c.key] = colSum(openMap, c.key); closing[c.key] = colSum(closeMap, c.key); }
    }

    // Period net movement per equity account (economic, signed by normalBalance).
    const dMap = new Map(movements.debitTotals.map(x => [x._id.toString(), x.total]));
    const cMap = new Map(movements.creditTotals.map(x => [x._id.toString(), x.total]));
    const netMove = (a) => {
      const d = dMap.get(a._id.toString()) || 0, c = cMap.get(a._id.toString()) || 0;
      return a.normalBalance === 'Debit' ? (d - c) : (c - d);
    };

    // Explicit movement rows (per component).
    const zero = () => Object.fromEntries(components.map(c => [c.key, 0]));
    const profit = zero(), capital = zero(), distributions = zero(), other = zero();

    // Profit for the period → synthetic CYE column.
    profit.currentYearEarnings = r2(
      (econ(closeMap, 'Revenue') - econ(openMap, 'Revenue')) -
      (econ(closeMap, 'Expense') - econ(openMap, 'Expense'))
    );

    // Capital injections (credit-normal capital/premium accounts) and distributions (debit-normal draws).
    for (const a of equityAccts) {
      const key = acctToComp.get(a._id.toString());
      const mv = netMove(a);
      const nm = (a.accountName || '').toLowerCase();
      if (/distribution|drawing|dividend/.test(nm) || a.accountCode === '3120') {
        distributions[key] = r2(distributions[key] + mv); // mv already negative for a draw
      } else if (/capital|investment|share premium/.test(nm) || ['3110', '3130'].includes(a.accountCode)) {
        capital[key] = r2(capital[key] + mv);
      }
    }

    // Other changes = residual per column so each column foots opening → closing exactly.
    for (const c of components) {
      const explained = profit[c.key] + capital[c.key] + distributions[c.key];
      other[c.key] = r2((closing[c.key] - opening[c.key]) - explained);
    }

    const rowTotal = (vals) => r2(components.reduce((s, c) => s + (vals[c.key] || 0), 0));
    const mkRow = (key, label, vals) => ({ key, label, values: vals, total: rowTotal(vals) });

    const rows = [
      mkRow('opening', 'Balance at start', opening),
      mkRow('profit', 'Profit for the period', profit),
      mkRow('capital', 'Money put in by owners', capital),
      mkRow('distributions', 'Money taken out / dividends', distributions),
      mkRow('other', 'Other changes', other),
      mkRow('closing', 'Balance at end', closing),
    ];

    const bs = await this.getBalanceSheet(businessId, endDate);
    const closingTotal = rowTotal(closing);
    const difference = r2(closingTotal - bs.totalEquity);

    const result = {
      components,
      rows,
      reconciliation: {
        closingTotal,
        balanceSheetEquity: r2(bs.totalEquity),
        difference,
        reconciles: Math.abs(difference) < 0.01,
      },
      period: { startDate, endDate },
    };
    reportCache.set('equity-statement', businessId.toString(), cacheParams, result);
    return result;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/services/report.equityStatement.test.js`
Expected: PASS (both assertions).

- [ ] **Step 5: Commit**

```bash
git add services/report.service.js tests/unit/services/report.equityStatement.test.js
git commit -m "$(cat <<'EOF'
feat(reports): statement of changes in equity service (FR-02.4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Equity statement — controller, route, validation, exports

**Files:**
- Modify: `controllers/report.controller.js`, `routes/v1/report.routes.js`, `validations/report.validation.js`, `utils/pdfExport.utils.js`, `utils/excelExport.utils.js`
- Test: `tests/integration/report.equity.test.js`

**Interfaces:**
- Consumes: `reportService.getStatementOfChangesInEquity(businessId, start, end)` (Task 1).
- Produces: `GET /api/v1/reports/equity?startDate&endDate`; `exportReport` `type=equity`.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/report.equity.test.js` (mirror an existing reports integration test for app + auth bootstrapping; if none exists, assert the route + validation wiring at the unit level instead):

```js
const request = require('supertest');
const app = require('../../app');
const { authHeaderForTestBusiness } = require('../helpers/auth'); // existing test helper

describe('GET /api/v1/reports/equity', () => {
  test('returns 200 with equity statement shape', async () => {
    const headers = await authHeaderForTestBusiness();
    const res = await request(app)
      .get('/api/v1/reports/equity?startDate=2026-01-01&endDate=2026-12-31')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('rows');
    expect(res.body.data).toHaveProperty('reconciliation');
    expect(res.body.data.rows.some(r => r.key === 'closing')).toBe(true);
  });
});
```

> If `tests/helpers/auth` does not exist, replace this with a unit test that imports the controller and asserts `getStatementOfChangesInEquity` calls the service with `toStartOfDay/toEndOfDay`-parsed dates and passes the result to `ApiResponse.success` (mock both). Do not invent a helper.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/integration/report.equity.test.js`
Expected: FAIL — 404 (route not mounted) or controller export missing.

- [ ] **Step 3: Write minimal implementation**

In `validations/report.validation.js`, add after `kpiSchema`:

```js
const equityStatementSchema = Joi.object({
  startDate: isoDate().optional(),
  endDate:   isoDate().optional(),
}).custom(dateRangeValidation);

const revenueNotesSchema = Joi.object({
  startDate: isoDate().optional(),
  endDate:   isoDate().optional(),
}).custom(dateRangeValidation);
```

Add `'equity'` to the `exportReportSchema` `type` `.valid(...)` list and its `asOfDate`-vs-range handling (equity is a range type):

```js
  type: Joi.string()
    .valid('incomeStatement', 'balanceSheet', 'cashFlow', 'trialBalance', 'generalLedger', 'aging', 'equity')
    .required()
```
and add `'equity'` to the three `Joi.string().valid('incomeStatement', 'cashFlow', 'generalLedger')` lists (startDate/endDate required, plus the custom range check), so equity requires `startDate`+`endDate`.

Export the two new schemas in `module.exports`: `equityStatementSchema, revenueNotesSchema`.

In `controllers/report.controller.js`, add handlers (after `getKPISummary`):

```js
const getStatementOfChangesInEquity = async (req, res, next) => {
  try {
    const { startDate, endDate } = resolveReportDates(req.query);
    const data = await reportService.getStatementOfChangesInEquity(
      req.user.businessId, toStartOfDay(startDate), toEndOfDay(endDate)
    );
    ApiResponse.success(res, data, 'Statement of changes in equity generated');
  } catch (err) { next(err); }
};

const getRevenueNotes = async (req, res, next) => {
  try {
    const { startDate, endDate } = resolveReportDates(req.query);
    const data = await reportService.getRevenueNotes(
      req.user.businessId, toStartOfDay(startDate), toEndOfDay(endDate)
    );
    ApiResponse.success(res, data, 'Revenue notes generated');
  } catch (err) { next(err); }
};
```

Add an `equity` case in `exportReport`'s `switch (type)` (after `aging`):

```js
      case 'equity': {
        reportData = await reportService.getStatementOfChangesInEquity(businessId, toStartOfDay(startDate), toEndOfDay(endDate));
        const period = `${startDate} to ${endDate}`;
        if (format === 'pdf') {
          fileBuffer  = await pdfExport.generateEquityStatementPDF({ businessName, data: reportData, dateRange: period, currency });
          filename    = `statement_of_changes_in_equity_${startDate}_to_${endDate}.pdf`;
          contentType = 'application/pdf';
        } else {
          fileBuffer  = await excelExport.generateExcelReport('equityStatement', reportData, { startDate, endDate });
          filename    = `statement_of_changes_in_equity_${startDate}_to_${endDate}.xlsx`;
          contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        }
        break;
      }
```

Add both handlers to `module.exports`: `getStatementOfChangesInEquity, getRevenueNotes`.

In `routes/v1/report.routes.js`, import the two new schemas and add routes (after the comparative routes, before export):

```js
router.get('/equity',          validate(equityStatementSchema, 'query'), ctrl.getStatementOfChangesInEquity);
router.get('/notes/revenue',   validate(revenueNotesSchema,    'query'), ctrl.getRevenueNotes);
```

In `utils/pdfExport.utils.js`, add `generateEquityStatementPDF` mirroring `generateBalanceSheetPDF` (same PDFKit setup/header/footer helpers). Render a header row of component labels, then one line per `data.rows` entry (label + each `values[componentKey]` + `total`), and a reconciliation footer (`reconciles` ✓/✗). Export it in the module's exports object.

In `utils/excelExport.utils.js`, add a `case 'equityStatement':` to `generateExcelReport` that writes a worksheet: first row = `['', ...components.map(c=>c.label), 'Total']`; then a row per `data.rows` (`label`, each component value, `total`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/integration/report.equity.test.js`
Expected: PASS (200 + shape).

- [ ] **Step 5: Commit**

```bash
git add controllers/report.controller.js routes/v1/report.routes.js validations/report.validation.js utils/pdfExport.utils.js utils/excelExport.utils.js tests/integration/report.equity.test.js
git commit -m "$(cat <<'EOF'
feat(reports): equity statement route + PDF/Excel export (FR-02.4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: IFRS-15 revenue notes — service

**Files:**
- Modify: `services/report.service.js`
- Test: `tests/unit/services/report.revenueNotes.test.js`

**Interfaces:**
- Consumes: `transactionRepository.getDebitCreditTotalsBetween`; `accountRepository.findByBusiness`.
- Produces: `report.service.getRevenueNotes(businessId, startDate, endDate)` → `{ policyText, disaggregation:[{stream, amount, pct}], totalRevenue, period }`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/services/report.revenueNotes.test.js`:

```js
const reportService = require('../../../services/report.service');
const accountRepository = require('../../../repositories/account.repository');
const transactionRepository = require('../../../repositories/transaction.repository');

jest.mock('../../../repositories/account.repository');
jest.mock('../../../repositories/transaction.repository');

describe('getRevenueNotes', () => {
  beforeEach(() => jest.clearAllMocks());

  test('disaggregates revenue by account and totals to income-statement revenue', async () => {
    accountRepository.findByBusiness.mockResolvedValue([
      { _id: 'r1', accountName: 'Product Sales', accountType: 'Revenue', normalBalance: 'Credit' },
      { _id: 'r2', accountName: 'Service Income', accountType: 'Revenue', normalBalance: 'Credit' },
      { _id: 'e1', accountName: 'Rent', accountType: 'Expense', normalBalance: 'Debit' },
    ]);
    transactionRepository.getDebitCreditTotalsBetween.mockResolvedValue({
      debitTotals: [],
      creditTotals: [{ _id: 'r1', total: 75000 }, { _id: 'r2', total: 25000 }],
    });

    const r = await reportService.getRevenueNotes('biz1', new Date('2026-01-01'), new Date('2026-12-31'));

    expect(r.totalRevenue).toBeCloseTo(100000, 2);
    const product = r.disaggregation.find(d => d.stream === 'Product Sales');
    expect(product.amount).toBeCloseTo(75000, 2);
    expect(product.pct).toBeCloseTo(75, 1);
    expect(typeof r.policyText).toBe('string');
    expect(r.policyText.length).toBeGreaterThan(40);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/services/report.revenueNotes.test.js`
Expected: FAIL — `getRevenueNotes is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `ReportService` (after `getStatementOfChangesInEquity`):

```js
  // ──────────────────────────────────────────────────────────────────────────
  //  IFRS-15 REVENUE NOTES  (revenue disaggregation + policy text)
  // ──────────────────────────────────────────────────────────────────────────
  async getRevenueNotes(businessId, startDate, endDate) {
    if (!businessId || !startDate || !endDate)
      throw new ApiError(400, 'Missing required parameters: businessId, startDate, endDate');

    const cacheParams = { start: new Date(startDate).toISOString(), end: new Date(endDate).toISOString() };
    const cached = reportCache.get('revenue-notes', businessId.toString(), cacheParams);
    if (cached) return cached;

    const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
    const [accounts, movements] = await Promise.all([
      accountRepository.findByBusiness(businessId),
      transactionRepository.getDebitCreditTotalsBetween(businessId, startDate, endDate),
    ]);

    const revAccts = accounts.filter(a => a.accountType === 'Revenue');
    const dMap = new Map(movements.debitTotals.map(x => [x._id.toString(), x.total]));
    const cMap = new Map(movements.creditTotals.map(x => [x._id.toString(), x.total]));

    const disaggregation = revAccts.map(a => {
      const id = a._id.toString();
      const amt = r2((cMap.get(id) || 0) - (dMap.get(id) || 0)); // economic revenue (credit-normal)
      return { stream: a.accountName, amount: amt };
    }).filter(d => d.amount !== 0);

    const totalRevenue = r2(disaggregation.reduce((s, d) => s + d.amount, 0));
    disaggregation.forEach(d => { d.pct = totalRevenue !== 0 ? r2((d.amount / totalRevenue) * 100) : 0; });
    disaggregation.sort((a, b) => b.amount - a.amount);

    const policyText =
      'Revenue is recognised when control of goods or services passes to the customer, ' +
      'measured at the amount the business expects to receive (IFRS 15). For each sale the ' +
      'business identifies the customer agreement and what it has promised to deliver, sets the ' +
      'price, and records revenue as each promise is fulfilled — at a point in time for goods, ' +
      'and over time for services delivered across a period. The table below breaks total revenue ' +
      'down by source so readers can see where income comes from.';

    const result = { policyText, disaggregation, totalRevenue, period: { startDate, endDate } };
    reportCache.set('revenue-notes', businessId.toString(), cacheParams, result);
    return result;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/services/report.revenueNotes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/report.service.js tests/unit/services/report.revenueNotes.test.js
git commit -m "$(cat <<'EOF'
feat(reports): IFRS-15 revenue disaggregation notes service

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

> The `GET /reports/notes/revenue` route + `getRevenueNotes` controller were already added in Task 2.

---

## Task 4: ReportTemplate model

**Files:**
- Create: `models/ReportTemplate.model.js`
- Test: `tests/unit/models/reportTemplate.model.test.js`

**Interfaces:**
- Produces: Mongoose model `ReportTemplate` with the schema in spec §4.1.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/models/reportTemplate.model.test.js`:

```js
const ReportTemplate = require('../../../models/ReportTemplate.model');

describe('ReportTemplate model', () => {
  test('requires businessId and name; defaults baseType to custom', () => {
    const t = new ReportTemplate({ businessId: '5f9d88b9c1234a0017a1b111', name: 'My P&L' });
    const err = t.validateSync();
    expect(err).toBeUndefined();
    expect(t.baseType).toBe('custom');
    expect(t.comparative.enabled).toBe(false);
    expect(t.schedule.enabled).toBe(false);
  });

  test('rejects an invalid baseType', () => {
    const t = new ReportTemplate({ businessId: '5f9d88b9c1234a0017a1b111', name: 'X', baseType: 'nope' });
    expect(t.validateSync()).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/models/reportTemplate.model.test.js`
Expected: FAIL — cannot find module `ReportTemplate.model`.

- [ ] **Step 3: Write minimal implementation**

Create `models/ReportTemplate.model.js`:

```js
const mongoose = require('mongoose');

const layoutRowSchema = new mongoose.Schema({
  id:             { type: String, required: true },
  kind:           { type: String, enum: ['section', 'account-group', 'account', 'subtotal', 'spacer'], required: true },
  label:          { type: String, default: '' },
  accountType:    { type: String },
  accountSubtype: { type: String },
  accountIds:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount' }],
  metric:         { type: String, enum: ['balance', 'flow'], default: 'balance' },
  visible:        { type: Boolean, default: true },
}, { _id: false });

const reportTemplateSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  name:       { type: String, required: true, trim: true, maxlength: 120 },
  baseType:   { type: String, enum: ['pl', 'bs', 'custom'], default: 'custom' },
  layout:     { type: [layoutRowSchema], default: [] },
  filters:    {
    costCenterId: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
  },
  comparative: {
    enabled:    { type: Boolean, default: false },
    mode:       { type: String, enum: ['prior-period', 'prior-year', 'custom'], default: 'prior-period' },
    priorStart: { type: Date, default: null },
    priorEnd:   { type: Date, default: null },
  },
  schedule: {
    enabled:    { type: Boolean, default: false },
    frequency:  { type: String, enum: ['daily', 'weekly', 'monthly'], default: 'monthly' },
    dayOfWeek:  { type: Number, min: 0, max: 6, default: 1 },
    dayOfMonth: { type: Number, min: 1, max: 28, default: 1 },
    hour:       { type: Number, min: 0, max: 23, default: 6 },
    recipients: [{ type: String, trim: true, lowercase: true }],
    format:     { type: String, enum: ['pdf'], default: 'pdf' },
    lastRunAt:  { type: Date, default: null },
    nextRunAt:  { type: Date, default: null },
  },
  createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

reportTemplateSchema.index({ 'schedule.enabled': 1, 'schedule.nextRunAt': 1 });

module.exports = mongoose.model('ReportTemplate', reportTemplateSchema);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/models/reportTemplate.model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add models/ReportTemplate.model.js tests/unit/models/reportTemplate.model.test.js
git commit -m "$(cat <<'EOF'
feat(reports): ReportTemplate model (FR-02.5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: ReportTemplate repository

**Files:**
- Create: `repositories/reportTemplate.repository.js`
- Test: `tests/unit/repositories/reportTemplate.repository.test.js`

**Interfaces:**
- Consumes: `BaseRepository` (`repositories/base.repository.js`); `ReportTemplate` model.
- Produces: singleton with `findOwned(businessId)`, `findOwnedById(businessId, id)`, `findScheduledDue(now)`, plus inherited `create/update/delete`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/repositories/reportTemplate.repository.test.js`:

```js
const repo = require('../../../repositories/reportTemplate.repository');
const ReportTemplate = require('../../../models/ReportTemplate.model');

jest.mock('../../../models/ReportTemplate.model');

describe('reportTemplate.repository', () => {
  beforeEach(() => jest.clearAllMocks());

  test('findScheduledDue queries enabled + due templates', async () => {
    const lean = jest.fn().mockResolvedValue([{ _id: 't1' }]);
    ReportTemplate.find.mockReturnValue({ lean });
    const now = new Date('2026-06-21T06:00:00Z');
    const r = await repo.findScheduledDue(now);
    expect(ReportTemplate.find).toHaveBeenCalledWith({
      'schedule.enabled': true,
      'schedule.nextRunAt': { $lte: now },
    });
    expect(r).toEqual([{ _id: 't1' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/repositories/reportTemplate.repository.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

Create `repositories/reportTemplate.repository.js`:

```js
const BaseRepository = require('./base.repository');
const ReportTemplate = require('../models/ReportTemplate.model');
const mongoose = require('mongoose');

class ReportTemplateRepository extends BaseRepository {
  constructor() { super(ReportTemplate); }

  async findOwned(businessId) {
    return this.model
      .find({ businessId: new mongoose.Types.ObjectId(String(businessId)) })
      .sort({ updatedAt: -1 })
      .lean();
  }

  async findOwnedById(businessId, id) {
    return this.model.findOne({
      _id: new mongoose.Types.ObjectId(String(id)),
      businessId: new mongoose.Types.ObjectId(String(businessId)),
    });
  }

  async findScheduledDue(now) {
    return this.model
      .find({ 'schedule.enabled': true, 'schedule.nextRunAt': { $lte: now } })
      .lean();
  }
}

module.exports = new ReportTemplateRepository();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/repositories/reportTemplate.repository.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add repositories/reportTemplate.repository.js tests/unit/repositories/reportTemplate.repository.test.js
git commit -m "$(cat <<'EOF'
feat(reports): ReportTemplate repository (FR-02.5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: reportBuilder service — render + comparative variance + default layouts

**Files:**
- Create: `services/reportBuilder.service.js`
- Test: `tests/unit/services/reportBuilder.service.test.js`

**Interfaces:**
- Consumes: `reportTemplate.repository.findOwnedById`; `report.service.getBalancesAsOf` (Task 1); `transactionRepository.getDebitCreditTotalsBetween`; `accountRepository.findByBusiness`.
- Produces:
  - `renderTemplate(businessId, templateId, { startDate, endDate, asOfDate })` → `{ template, columns, rows, period, generatedAt }`.
  - `previewLayout(businessId, payload, dateOpts)` → same render shape from an unsaved `{ baseType, layout, filters, comparative }`.
  - `defaultLayoutFor(baseType, accounts)` → `layout[]`.
  - `computeComparativeWindow(mode, startDate, endDate, custom)` → `{ priorStart, priorEnd }` (pure, exported for reuse/testing).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/services/reportBuilder.service.test.js`:

```js
const builder = require('../../../services/reportBuilder.service');

describe('computeComparativeWindow', () => {
  test('prior-period is the immediately preceding equal-length window', () => {
    const { priorStart, priorEnd } = builder.computeComparativeWindow(
      'prior-period', new Date('2026-04-01'), new Date('2026-06-30')
    );
    // 91-day window → prior ends the day before start
    expect(priorEnd.toISOString().slice(0, 10)).toBe('2026-03-31');
    expect(priorStart.toISOString().slice(0, 10)).toBe('2025-12-31');
  });

  test('prior-year shifts the window back one year', () => {
    const { priorStart, priorEnd } = builder.computeComparativeWindow(
      'prior-year', new Date('2026-04-01'), new Date('2026-06-30')
    );
    expect(priorStart.toISOString().slice(0, 10)).toBe('2025-04-01');
    expect(priorEnd.toISOString().slice(0, 10)).toBe('2025-06-30');
  });
});

describe('renderTemplate', () => {
  test('renders rows with comparative absolute + percent variance', async () => {
    const reportTemplateRepo = require('../../../repositories/reportTemplate.repository');
    const reportService = require('../../../services/report.service');
    const accountRepository = require('../../../repositories/account.repository');
    const transactionRepository = require('../../../repositories/transaction.repository');
    jest.spyOn(reportTemplateRepo, 'findOwnedById').mockResolvedValue({
      _id: 't1', name: 'P&L', baseType: 'pl',
      filters: {}, comparative: { enabled: true, mode: 'prior-year' },
      layout: [{ id: 'r1', kind: 'account', label: 'Sales', accountIds: ['rev'], metric: 'flow', visible: true }],
    });
    jest.spyOn(accountRepository, 'findByBusiness').mockResolvedValue([
      { _id: 'rev', accountName: 'Sales', accountType: 'Revenue', normalBalance: 'Credit' },
    ]);
    jest.spyOn(transactionRepository, 'getDebitCreditTotalsBetween').mockImplementation(async (_b, s) =>
      new Date(s).getFullYear() === 2026
        ? { debitTotals: [], creditTotals: [{ _id: 'rev', total: 120000 }] }
        : { debitTotals: [], creditTotals: [{ _id: 'rev', total: 100000 }] }
    );

    const r = await builder.renderTemplate('biz1', 't1', { startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31') });
    const row = r.rows.find(x => x.id === 'r1');
    expect(row.current).toBeCloseTo(120000, 2);
    expect(row.prior).toBeCloseTo(100000, 2);
    expect(row.change).toBeCloseTo(20000, 2);
    expect(row.changePct).toBeCloseTo(20, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/services/reportBuilder.service.test.js`
Expected: FAIL — cannot find module `reportBuilder.service`.

- [ ] **Step 3: Write minimal implementation**

Create `services/reportBuilder.service.js`:

```js
'use strict';

const reportTemplateRepo = require('../repositories/reportTemplate.repository');
const reportService = require('./report.service');
const accountRepository = require('../repositories/account.repository');
const transactionRepository = require('../repositories/transaction.repository');
const { ApiError } = require('../utils/ApiError');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const DAY = 86400000;

/** Pure: compute the comparative prior window for a given mode. */
function computeComparativeWindow(mode, startDate, endDate, custom = {}) {
  const s = new Date(startDate), e = new Date(endDate);
  if (mode === 'custom') {
    return { priorStart: new Date(custom.priorStart), priorEnd: new Date(custom.priorEnd) };
  }
  if (mode === 'prior-year') {
    const priorStart = new Date(s); priorStart.setFullYear(s.getFullYear() - 1);
    const priorEnd = new Date(e); priorEnd.setFullYear(e.getFullYear() - 1);
    return { priorStart, priorEnd };
  }
  // prior-period: immediately preceding window of equal length
  const len = e.getTime() - s.getTime();
  const priorEnd = new Date(s.getTime() - DAY);
  const priorStart = new Date(priorEnd.getTime() - len);
  return { priorStart, priorEnd };
}

/** Seed a starter layout from the chart of accounts. */
function defaultLayoutFor(baseType, accounts) {
  const mk = (id, kind, label, extra = {}) => ({ id, kind, label, visible: true, metric: 'balance', ...extra });
  if (baseType === 'pl') {
    const rev = accounts.filter(a => a.accountType === 'Revenue').map(a => a._id);
    const exp = accounts.filter(a => ['Expense', 'Direct Cost'].includes(a.accountType)).map(a => a._id);
    return [
      mk('s-rev', 'section', 'Income'),
      mk('g-rev', 'account-group', 'Revenue', { accountType: 'Revenue', accountIds: rev, metric: 'flow' }),
      mk('s-exp', 'section', 'Spending'),
      mk('g-exp', 'account-group', 'Expenses', { accountType: 'Expense', accountIds: exp, metric: 'flow' }),
      mk('sub-net', 'subtotal', 'Profit (Income − Spending)', { metric: 'flow' }),
    ];
  }
  if (baseType === 'bs') {
    const byType = (t) => accounts.filter(a => a.accountType === t).map(a => a._id);
    return [
      mk('s-as', 'section', 'What the business owns'),
      mk('g-as', 'account-group', 'Assets', { accountType: 'Asset', accountIds: byType('Asset') }),
      mk('s-li', 'section', 'What the business owes'),
      mk('g-li', 'account-group', 'Liabilities', { accountType: 'Liability', accountIds: byType('Liability') }),
      mk('s-eq', 'section', "Owners' stake"),
      mk('g-eq', 'account-group', 'Equity', { accountType: 'Equity', accountIds: byType('Equity') }),
    ];
  }
  return [mk('s-1', 'section', 'New section')];
}

/** Sum a layout row's accounts from balance + flow maps (economic, signed by normalBalance). */
function _rowValue(row, accMap, balMap, flowMap) {
  if (!['account', 'account-group'].includes(row.kind)) return 0;
  const ids = row.accountIds || [];
  const map = row.metric === 'flow' ? flowMap : balMap;
  let v = 0;
  for (const id of ids) v += map.get(String(id)) || 0;
  return r2(v);
}

/** Build an economic balance map: { accountId -> signed amount } from a getBalancesAsOf result. */
function _toBalMap(balancesObj) {
  return new Map(Object.entries(balancesObj || {}));
}

/** Build an economic flow map from getDebitCreditTotalsBetween, signed by normalBalance. */
function _toFlowMap(movements, accById) {
  const dMap = new Map(movements.debitTotals.map(x => [x._id.toString(), x.total]));
  const cMap = new Map(movements.creditTotals.map(x => [x._id.toString(), x.total]));
  const out = new Map();
  for (const [id, acc] of accById) {
    const d = dMap.get(id) || 0, c = cMap.get(id) || 0;
    out.set(id, acc.normalBalance === 'Debit' ? (d - c) : (c - d));
  }
  return out;
}

async function _assemble(businessId, template, dateOpts) {
  const startDate = dateOpts.startDate, endDate = dateOpts.endDate;
  const asOfDate = dateOpts.asOfDate || endDate;
  const comparative = template.comparative || { enabled: false };

  const accounts = await accountRepository.findByBusiness(businessId);
  const accById = new Map(accounts.map(a => [a._id.toString(), a]));

  // Current columns
  const [curBal, curMove] = await Promise.all([
    reportService.getBalancesAsOf(businessId, asOfDate),
    transactionRepository.getDebitCreditTotalsBetween(businessId, startDate, endDate),
  ]);
  const curBalMap = _toBalMap(curBal);
  const curFlowMap = _toFlowMap(curMove, accById);

  // Prior columns (optional)
  let priBalMap = null, priFlowMap = null, priorWindow = null;
  if (comparative.enabled) {
    priorWindow = computeComparativeWindow(comparative.mode, startDate, endDate, comparative);
    const [priBal, priMove] = await Promise.all([
      reportService.getBalancesAsOf(businessId, priorWindow.priorEnd),
      transactionRepository.getDebitCreditTotalsBetween(businessId, priorWindow.priorStart, priorWindow.priorEnd),
    ]);
    priBalMap = _toBalMap(priBal);
    priFlowMap = _toFlowMap(priMove, accById);
  }

  const rows = [];
  let runningSub = 0, runningSubPrior = 0;
  for (const row of (template.layout || [])) {
    if (row.visible === false) continue;
    let current = 0, prior = null;
    if (row.kind === 'subtotal') {
      current = r2(runningSub); prior = comparative.enabled ? r2(runningSubPrior) : null;
      runningSub = 0; runningSubPrior = 0;
    } else if (['account', 'account-group'].includes(row.kind)) {
      current = _rowValue(row, accById, curBalMap, curFlowMap);
      runningSub += current;
      if (comparative.enabled) { prior = _rowValue(row, accById, priBalMap, priFlowMap); runningSubPrior += prior; }
    }
    const out = { id: row.id, kind: row.kind, label: row.label, current };
    if (comparative.enabled && ['account', 'account-group', 'subtotal'].includes(row.kind)) {
      out.prior = prior;
      out.change = r2(current - prior);
      out.changePct = prior !== 0 ? r2(((current - prior) / Math.abs(prior)) * 100) : null;
    }
    rows.push(out);
  }

  return {
    template: { id: template._id || null, name: template.name, baseType: template.baseType, comparative },
    columns: comparative.enabled
      ? ['Current', 'Prior', 'Change', 'Change %']
      : ['Amount'],
    rows,
    period: { startDate, endDate, asOfDate, prior: priorWindow },
    generatedAt: new Date(),
  };
}

async function renderTemplate(businessId, templateId, dateOpts) {
  const template = await reportTemplateRepo.findOwnedById(businessId, templateId);
  if (!template) throw new ApiError(404, 'Report not found');
  return _assemble(businessId, template, dateOpts);
}

async function previewLayout(businessId, payload, dateOpts) {
  const template = {
    _id: null,
    name: payload.name || 'Preview',
    baseType: payload.baseType || 'custom',
    layout: payload.layout || [],
    filters: payload.filters || {},
    comparative: payload.comparative || { enabled: false },
  };
  return _assemble(businessId, template, dateOpts);
}

module.exports = {
  renderTemplate,
  previewLayout,
  defaultLayoutFor,
  computeComparativeWindow,
};
```

> Note: `filters.costCenterId` is accepted and stored now; cost-centre-scoped flow filtering can be layered onto `_toFlowMap` later via `EFFECTIVE_LINES_STAGE` without changing this interface. Keep YAGNI — wire the filter through only when the UI exposes it (Task 9 ships the toggle but renders unfiltered totals until then; do not block on it).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/services/reportBuilder.service.test.js`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add services/reportBuilder.service.js tests/unit/services/reportBuilder.service.test.js
git commit -m "$(cat <<'EOF'
feat(reports): reportBuilder render + comparative variance service (FR-02.5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Report template — controller, validation, routes

**Files:**
- Create: `controllers/reportTemplate.controller.js`, `validations/reportTemplate.validation.js`
- Modify: `routes/v1/report.routes.js`
- Test: `tests/unit/controllers/reportTemplate.controller.test.js`

**Interfaces:**
- Consumes: `reportTemplate.repository`; `reportBuilder.service`; `report.service.getBalancesAsOf`; `accountRepository`.
- Produces routes (all under `/api/v1/reports`): `GET/POST /templates`, `GET/PUT/DELETE /templates/:id`, `POST /templates/:id/render`, `POST /templates/preview`, `PUT /templates/:id/schedule`, `GET /templates/:id/export`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/controllers/reportTemplate.controller.test.js`:

```js
const ctrl = require('../../../controllers/reportTemplate.controller');
const repo = require('../../../repositories/reportTemplate.repository');
jest.mock('../../../repositories/reportTemplate.repository');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

describe('reportTemplate.controller.list', () => {
  test('returns owned templates', async () => {
    repo.findOwned.mockResolvedValue([{ _id: 't1', name: 'P&L' }]);
    const req = { user: { businessId: 'biz1' } };
    const res = mockRes();
    await ctrl.list(req, res, (e) => { throw e; });
    expect(repo.findOwned).toHaveBeenCalledWith('biz1');
    expect(res.json).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/controllers/reportTemplate.controller.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

Create `validations/reportTemplate.validation.js`:

```js
const Joi = require('joi');

const layoutRow = Joi.object({
  id: Joi.string().required(),
  kind: Joi.string().valid('section', 'account-group', 'account', 'subtotal', 'spacer').required(),
  label: Joi.string().allow('').default(''),
  accountType: Joi.string().optional(),
  accountSubtype: Joi.string().optional(),
  accountIds: Joi.array().items(Joi.string().hex().length(24)).optional(),
  metric: Joi.string().valid('balance', 'flow').default('balance'),
  visible: Joi.boolean().default(true),
});

const comparative = Joi.object({
  enabled: Joi.boolean().default(false),
  mode: Joi.string().valid('prior-period', 'prior-year', 'custom').default('prior-period'),
  priorStart: Joi.date().iso().optional(),
  priorEnd: Joi.date().iso().optional(),
});

const createTemplateSchema = Joi.object({
  name: Joi.string().max(120).required(),
  baseType: Joi.string().valid('pl', 'bs', 'custom').default('custom'),
  layout: Joi.array().items(layoutRow).default([]),
  filters: Joi.object({ costCenterId: Joi.string().hex().length(24).allow(null) }).default({}),
  comparative: comparative.default({ enabled: false }),
});

const updateTemplateSchema = createTemplateSchema.fork(['name'], (s) => s.optional());

const renderSchema = Joi.object({
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  asOfDate: Joi.date().iso().optional(),
});

const previewSchema = createTemplateSchema.keys({
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  asOfDate: Joi.date().iso().optional(),
});

const scheduleSchema = Joi.object({
  enabled: Joi.boolean().required(),
  frequency: Joi.string().valid('daily', 'weekly', 'monthly').default('monthly'),
  dayOfWeek: Joi.number().min(0).max(6).default(1),
  dayOfMonth: Joi.number().min(1).max(28).default(1),
  hour: Joi.number().min(0).max(23).default(6),
  recipients: Joi.array().items(Joi.string().email()).default([]),
});

module.exports = {
  createTemplateSchema, updateTemplateSchema, renderSchema, previewSchema, scheduleSchema,
};
```

Create `controllers/reportTemplate.controller.js`:

```js
const repo = require('../repositories/reportTemplate.repository');
const reportBuilder = require('../services/reportBuilder.service');
const ApiResponse = require('../utils/ApiResponse');
const { ApiError } = require('../utils/ApiError');
const { computeNextRun } = require('../jobs/scheduledReport.job');
const mongoose = require('mongoose');

const today = () => new Date().toISOString().split('T')[0];
const yearStart = () => `${new Date().getFullYear()}-01-01`;
const range = (q) => ({
  startDate: new Date(q.startDate || yearStart()),
  endDate: new Date(q.endDate || today()),
  asOfDate: q.asOfDate ? new Date(q.asOfDate) : undefined,
});

const list = async (req, res, next) => {
  try { ApiResponse.success(res, await repo.findOwned(req.user.businessId), 'Reports listed'); }
  catch (e) { next(e); }
};

const create = async (req, res, next) => {
  try {
    const doc = await repo.create({
      ...req.body,
      businessId: new mongoose.Types.ObjectId(String(req.user.businessId)),
      createdBy: req.user.id ? new mongoose.Types.ObjectId(String(req.user.id)) : undefined,
    });
    ApiResponse.created(res, doc, 'Report saved');
  } catch (e) { next(e); }
};

const getOne = async (req, res, next) => {
  try {
    const doc = await repo.findOwnedById(req.user.businessId, req.params.id);
    if (!doc) throw new ApiError(404, 'Report not found');
    ApiResponse.success(res, doc, 'Report loaded');
  } catch (e) { next(e); }
};

const update = async (req, res, next) => {
  try {
    const doc = await repo.findOwnedById(req.user.businessId, req.params.id);
    if (!doc) throw new ApiError(404, 'Report not found');
    Object.assign(doc, req.body);
    await doc.save();
    ApiResponse.success(res, doc, 'Report updated');
  } catch (e) { next(e); }
};

const remove = async (req, res, next) => {
  try {
    const doc = await repo.findOwnedById(req.user.businessId, req.params.id);
    if (!doc) throw new ApiError(404, 'Report not found');
    await doc.deleteOne();
    ApiResponse.success(res, { id: req.params.id }, 'Report deleted');
  } catch (e) { next(e); }
};

const render = async (req, res, next) => {
  try {
    const data = await reportBuilder.renderTemplate(req.user.businessId, req.params.id, range(req.body));
    ApiResponse.success(res, data, 'Report rendered');
  } catch (e) { next(e); }
};

const preview = async (req, res, next) => {
  try {
    const { startDate, endDate, asOfDate, ...layoutPayload } = req.body;
    const data = await reportBuilder.previewLayout(req.user.businessId, layoutPayload, range({ startDate, endDate, asOfDate }));
    ApiResponse.success(res, data, 'Preview rendered');
  } catch (e) { next(e); }
};

const setSchedule = async (req, res, next) => {
  try {
    const doc = await repo.findOwnedById(req.user.businessId, req.params.id);
    if (!doc) throw new ApiError(404, 'Report not found');
    doc.schedule = {
      ...doc.schedule.toObject?.() ?? doc.schedule,
      ...req.body,
      format: 'pdf',
      nextRunAt: req.body.enabled ? computeNextRun(req.body, new Date()) : null,
    };
    await doc.save();
    ApiResponse.success(res, doc, req.body.enabled ? 'Schedule set' : 'Schedule turned off');
  } catch (e) { next(e); }
};

module.exports = { list, create, getOne, update, remove, render, preview, setSchedule };
```

> `GET /templates/:id/export` is added in Task 8 (after the PDF helper exists) to avoid a forward reference; the route + handler land together there.

In `routes/v1/report.routes.js`, import and mount (after the `/notes/revenue` route):

```js
const tplCtrl = require('../../controllers/reportTemplate.controller');
const {
  createTemplateSchema, updateTemplateSchema, renderSchema, previewSchema, scheduleSchema,
} = require('../../validations/reportTemplate.validation');

router.get('/templates',              tplCtrl.list);
router.post('/templates',             validate(createTemplateSchema, 'body'), tplCtrl.create);
router.post('/templates/preview',     validate(previewSchema, 'body'),       tplCtrl.preview);
router.get('/templates/:id',          tplCtrl.getOne);
router.put('/templates/:id',          validate(updateTemplateSchema, 'body'), tplCtrl.update);
router.delete('/templates/:id',       tplCtrl.remove);
router.post('/templates/:id/render',  validate(renderSchema, 'body'),        tplCtrl.render);
router.put('/templates/:id/schedule', validate(scheduleSchema, 'body'),      tplCtrl.setSchedule);
```

> Route order matters: `/templates/preview` is declared before `/templates/:id` so "preview" is not captured as an id.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/controllers/reportTemplate.controller.test.js`
Expected: PASS.

> If the controller import fails because `jobs/scheduledReport.job` does not exist yet, complete Task 8 first (it exports `computeNextRun`), then re-run. The plan orders Task 8 immediately after so this resolves within the same review cycle. To keep Task 7 self-contained, you may temporarily inline `computeNextRun` and move it in Task 8 — but the recommended path is to implement Task 8's `computeNextRun` export first since it is a pure function with its own test.

- [ ] **Step 5: Commit**

```bash
git add controllers/reportTemplate.controller.js validations/reportTemplate.validation.js routes/v1/report.routes.js tests/unit/controllers/reportTemplate.controller.test.js
git commit -m "$(cat <<'EOF'
feat(reports): report template CRUD + render/preview/schedule routes (FR-02.5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Scheduled report delivery — cron job + email attachment + export route + server wiring

**Files:**
- Create: `jobs/scheduledReport.job.js`
- Modify: `utils/email.utils.js`, `controllers/reportTemplate.controller.js`, `routes/v1/report.routes.js`, `server.js`
- Test: `tests/unit/jobs/scheduledReport.job.test.js`

**Interfaces:**
- Consumes: `reportTemplate.repository.findScheduledDue`; `reportBuilder.renderTemplate`; `utils/pdfExport.utils`; `utils/email.utils.sendEmail({ to, subject, html, attachments })`; `businessRepository.findById`.
- Produces: `computeNextRun(schedule, fromDate)` (pure) and `scheduleReportDelivery()` (registers cron). `GET /templates/:id/export`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/jobs/scheduledReport.job.test.js`:

```js
const { computeNextRun } = require('../../../jobs/scheduledReport.job');

describe('computeNextRun', () => {
  test('daily → next day at the configured hour', () => {
    const from = new Date('2026-06-21T10:00:00Z');
    const next = computeNextRun({ frequency: 'daily', hour: 6 }, from);
    expect(next.getUTCDate()).toBe(22);
    expect(next.getUTCHours()).toBe(6);
  });

  test('weekly → next configured weekday', () => {
    const from = new Date('2026-06-21T10:00:00Z'); // Sunday (day 0)
    const next = computeNextRun({ frequency: 'weekly', dayOfWeek: 3, hour: 6 }, from); // Wednesday
    expect(next.getUTCDay()).toBe(3);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });

  test('monthly → configured day of next month', () => {
    const from = new Date('2026-06-21T10:00:00Z');
    const next = computeNextRun({ frequency: 'monthly', dayOfMonth: 1, hour: 6 }, from);
    expect(next.getUTCDate()).toBe(1);
    expect(next.getUTCMonth()).toBe(6); // July (0-indexed)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/jobs/scheduledReport.job.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

Create `jobs/scheduledReport.job.js`:

```js
'use strict';

const cron = require('node-cron');
const reportTemplateRepo = require('../repositories/reportTemplate.repository');
const reportBuilder = require('../services/reportBuilder.service');
const businessRepository = require('../repositories/business.repository');
const pdfExport = require('../utils/pdfExport.utils');
const { sendEmail } = require('../utils/email.utils');
const logger = require('../config/logger');

/** Pure: next run instant given a schedule and a reference time (UTC). */
function computeNextRun(schedule, fromDate) {
  const from = new Date(fromDate);
  const hour = Number.isInteger(schedule.hour) ? schedule.hour : 6;
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hour, 0, 0, 0));
  if (schedule.frequency === 'daily') {
    if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  if (schedule.frequency === 'weekly') {
    const target = Number.isInteger(schedule.dayOfWeek) ? schedule.dayOfWeek : 1;
    let delta = (target - next.getUTCDay() + 7) % 7;
    if (delta === 0 && next <= from) delta = 7;
    next.setUTCDate(next.getUTCDate() + delta);
    return next;
  }
  // monthly
  const dom = Number.isInteger(schedule.dayOfMonth) ? schedule.dayOfMonth : 1;
  next.setUTCDate(dom);
  if (next <= from) next.setUTCMonth(next.getUTCMonth() + 1, dom);
  return next;
}

/** Render + email every template whose schedule is due. One failure never aborts the sweep. */
async function runDueReports(now = new Date()) {
  const due = await reportTemplateRepo.findScheduledDue(now);
  let sent = 0;
  for (const tpl of due) {
    try {
      const recipients = (tpl.schedule.recipients || []).filter(Boolean);
      if (recipients.length === 0) continue;

      const business = await businessRepository.findById(tpl.businessId);
      const endDate = new Date(now);
      const startDate = new Date(Date.UTC(endDate.getUTCFullYear(), 0, 1));
      const data = await reportBuilder.renderTemplate(tpl.businessId, tpl._id, { startDate, endDate });

      const pdf = await pdfExport.generateReportBuilderPDF({
        businessName: business?.businessName || 'My Business',
        currency: business?.currency || 'PKR',
        data,
        title: tpl.name,
      });

      await sendEmail({
        to: recipients.join(','),
        subject: `${tpl.name} — ${business?.businessName || 'your business'}`,
        html: `<p>Your scheduled report "<strong>${tpl.name}</strong>" is attached as a PDF.</p>`,
        attachments: [{ filename: `${tpl.name.replace(/[^\w-]+/g, '_')}.pdf`, content: pdf }],
      });

      await reportTemplateRepo.update(tpl._id, {
        'schedule.lastRunAt': now,
        'schedule.nextRunAt': computeNextRun(tpl.schedule, now),
      });
      sent++;
    } catch (err) {
      logger.error(`[scheduledReport] template ${tpl._id} failed: ${err.message}`);
    }
  }
  return { due: due.length, sent };
}

/** Register the hourly cron. */
function scheduleReportDelivery() {
  cron.schedule('5 * * * *', async () => {
    try {
      const r = await runDueReports(new Date());
      if (r.sent) logger.info(`[cron] scheduledReport: sent ${r.sent}/${r.due}`);
    } catch (err) {
      logger.error(`[cron] scheduledReport error: ${err.message}`);
    }
  });
  logger.info('[cron] scheduledReport delivery registered (hourly)');
}

module.exports = { computeNextRun, runDueReports, scheduleReportDelivery };
```

In `utils/email.utils.js`, pass attachments through (change the `mailOptions` object inside `sendEmail`):

```js
  const mailOptions = {
    from: config.EMAIL_FROM,
    to: options.to,
    subject: options.subject,
    html: options.html,
    ...(options.attachments ? { attachments: options.attachments } : {}),
  };
```

In `utils/pdfExport.utils.js`, add `generateReportBuilderPDF({ businessName, currency, data, title })` — mirror `generateBalanceSheetPDF`'s PDFKit scaffold: title + business name + period, then a table with a header row from `data.columns` and one line per `data.rows` entry (label left; `current` and, when present, `prior`/`change`/`changePct` right-aligned). Export it.

Add the export route + handler. In `controllers/reportTemplate.controller.js`, add:

```js
const businessRepository = require('../repositories/business.repository');
const pdfExport = require('../utils/pdfExport.utils');

const exportTemplate = async (req, res, next) => {
  try {
    const format = req.query.format === 'csv' ? 'csv' : 'pdf';
    const data = await reportBuilder.renderTemplate(req.user.businessId, req.params.id, range(req.query));
    const business = await businessRepository.findById(req.user.businessId);
    if (format === 'csv') {
      const head = ['Line', ...data.columns].join(',');
      const lines = data.rows.map(r => [
        `"${(r.label || '').replace(/"/g, '""')}"`,
        r.current ?? '', r.prior ?? '', r.change ?? '', r.changePct ?? '',
      ].slice(0, 1 + data.columns.length).join(','));
      const csv = [head, ...lines].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${(data.template.name||'report')}.csv"`);
      return res.send(csv);
    }
    const pdf = await pdfExport.generateReportBuilderPDF({
      businessName: business?.businessName || 'My Business',
      currency: business?.currency || 'PKR', data, title: data.template.name,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${(data.template.name||'report')}.pdf"`);
    res.send(pdf);
  } catch (e) { next(e); }
};

module.exports = { list, create, getOne, update, remove, render, preview, setSchedule, exportTemplate };
```

In `routes/v1/report.routes.js`, add after the schedule route:

```js
router.get('/templates/:id/export', tplCtrl.exportTemplate);
```

In `server.js`, add the import near the other job imports and call it where the other `schedule*()` jobs are started:

```js
const { scheduleReportDelivery } = require('./jobs/scheduledReport.job');
// ... inside the job-startup block, alongside scheduleTaxSnapshots() etc.:
scheduleReportDelivery();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/unit/jobs/scheduledReport.job.test.js`
Expected: PASS (3 cases).
Run: `npx jest tests/unit/controllers/reportTemplate.controller.test.js`
Expected: PASS (now that `computeNextRun` is exported).

- [ ] **Step 5: Commit**

```bash
git add jobs/scheduledReport.job.js utils/email.utils.js utils/pdfExport.utils.js controllers/reportTemplate.controller.js routes/v1/report.routes.js server.js tests/unit/jobs/scheduledReport.job.test.js
git commit -m "$(cat <<'EOF'
feat(reports): scheduled report email delivery + export route (FR-02.5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Full backend suite green

**Files:**
- Test: entire `tests/` suite.

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: all suites pass (prior baseline 154 suites / 1168 tests + the new equity/notes/builder/job/model/repo tests). If a pre-existing flake appears, re-run once in-band: `npx jest --runInBand`.

- [ ] **Step 2: Run the ledger drift script (no ledger writes were added, must read 0)**

Run: `node scripts/ledgerDrift.js`
Expected: drift 0 for all businesses (this phase is read-only on the ledger).

- [ ] **Step 3: Commit (only if any fixes were needed)**

```bash
git add -A
git commit -m "$(cat <<'EOF'
test(reports): green suite for equity + report builder + notes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Frontend — Equity Statement page + Revenue notes panel

**Files:**
- Create: `src/pages/reports/EquityStatementPage.jsx`
- Modify: `src/hooks/useReports.js`, the report API service, `src/pages/reports/IncomeStatementPage.jsx`, routes file, reports nav config.
- Test: manual via preview (frontend has no jest harness for pages).

**Interfaces:**
- Consumes: `GET /reports/equity`, `GET /reports/notes/revenue`.
- Produces: `useEquityStatement({ startDate, endDate })`, `useRevenueNotes({ startDate, endDate })`.

- [ ] **Step 1: Add hooks**

In `src/hooks/useReports.js`, mirror the existing `useBalanceSheet` pattern (same `useQuery` + `api.get` + `staleTime`). Add:

```js
export function useEquityStatement({ startDate, endDate }) {
  return useQuery({
    queryKey: ['report', 'equity', startDate, endDate],
    queryFn: async () => (await api.get('/reports/equity', { params: { startDate, endDate } })).data.data,
    staleTime: 5 * 60 * 1000,
  });
}

export function useRevenueNotes({ startDate, endDate }) {
  return useQuery({
    queryKey: ['report', 'revenue-notes', startDate, endDate],
    queryFn: async () => (await api.get('/reports/notes/revenue', { params: { startDate, endDate } })).data.data,
    staleTime: 5 * 60 * 1000,
  });
}
```

(Match the existing import of `api` and `useQuery` already used in that file.)

- [ ] **Step 2: Build the Equity Statement page**

Create `src/pages/reports/EquityStatementPage.jsx` following `BalanceSheetPage.jsx`: a start/end date range (default: year-to-date), a reconciliation badge driven by `data.reconciliation.reconciles`, and a matrix table — first header row = `['', ...data.components.map(c => c.label), 'Total']`, then one row per `data.rows` (plain-language `row.label`, each `row.values[component.key]` via `formatCurrency`, and `row.total`). Bold the `opening`/`closing` rows. Add an `ExportButton` for CSV (flatten rows × components) and a "Download PDF" using the export endpoint pattern (`/reports/export?type=equity&format=pdf&startDate&endDate`).

- [ ] **Step 3: Add the Revenue notes panel to the Income Statement**

In `src/pages/reports/IncomeStatementPage.jsx`, add a collapsible panel "Revenue notes (IFRS 15)" using `useRevenueNotes` with the same date range the page already uses: render `data.policyText` as a paragraph and `data.disaggregation` as a small table (`stream`, `amount`, `pct`). Default collapsed; toggle with a chevron (reuse the lucide `ChevronDown/ChevronRight` already imported in `BalanceSheetPage`).

- [ ] **Step 4: Wire routes + nav**

Add lazy routes for `/reports/equity` (and the report builder route placeholder for Task 11) to the reports routes file using the established `React.lazy()` + `withSuspense()` pattern. Add an "Equity Statement" entry to the reports nav config next to "Balance Sheet".

- [ ] **Step 5: Verify in preview + commit**

Start the dev server (preview_start), navigate to `/reports/equity`, confirm the matrix renders and the reconciliation badge is green, and confirm the Income Statement shows the collapsible notes panel. Screenshot for proof. Then:

```bash
git add src/pages/reports/EquityStatementPage.jsx src/hooks/useReports.js src/pages/reports/IncomeStatementPage.jsx
# plus the routes + nav files you modified
git commit -m "$(cat <<'EOF'
feat(reports): equity statement page + IFRS-15 revenue notes panel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Frontend — Report Builder page

**Files:**
- Create: `src/pages/reports/ReportBuilderPage.jsx`
- Modify: report API service, `src/hooks/useReports.js`, routes file, reports nav config.

**Interfaces:**
- Consumes: `/reports/templates` (list/create/get/update/delete), `/reports/templates/:id/render`, `/reports/templates/preview`, `/reports/templates/:id/schedule`, `/reports/templates/:id/export`.
- Produces: `useReportTemplates()`, `useReportTemplate(id)`, and mutation hooks (`useSaveTemplate`, `useDeleteTemplate`, `useRenderTemplate`, `usePreviewTemplate`, `useScheduleTemplate`).

- [ ] **Step 1: Add template hooks**

In `src/hooks/useReports.js`, add a `useReportTemplates()` list query, a `useReportTemplate(id)` query, and mutations for create/update/delete/render/preview/schedule using `useMutation` + `queryClient.invalidateQueries(['report','templates'])`, matching the mutation pattern used elsewhere in the app (e.g. budget or cost hooks).

- [ ] **Step 2: Build the list view**

Create `src/pages/reports/ReportBuilderPage.jsx`. Top-level: cards for each saved template (name, baseType badge, a "Scheduled · weekly" badge when `schedule.enabled`), plus a "New report" button opening a base picker (P&L / Balance Sheet / Blank). Selecting a base creates a draft layout client-side via a small local copy of `defaultLayoutFor` mapping (or fetch `accounts` and build group rows inline) — keep it minimal: section + one account-group per type.

- [ ] **Step 3: Build the builder view**

In the same file, the builder shows the ordered `layout` rows. Each row has: a label, a **Move up** and **Move down** button (swap with neighbor in local state — use a `useRef` id counter for new row ids, never `Date.now()` in a handler, per the eslint purity rule), a **show/hide** toggle, and a remove button. Controls above: base type (read-only badge), comparative selector (None / Prior period / Prior year), date range, **Preview** (calls preview/render and shows the returned `rows` in a table with comparative columns when enabled), **Save** (create or update), **Schedule** (dialog: frequency + day + recipient emails → calls schedule), **Export PDF** / **Export CSV** (open the export endpoint).

- [ ] **Step 4: Wire route + nav**

Add lazy routes `/reports/builder` and `/reports/builder/:id` (the route placeholder added in Task 10 becomes the real component). Add a "Report Builder" entry to the reports nav config.

- [ ] **Step 5: Verify in preview + commit**

Start the dev server, create a P&L template, reorder a row, toggle comparative (prior year), Preview (confirm variance columns), Save, set a weekly schedule with a test email, Export CSV. Screenshot the builder + a rendered comparative preview. Confirm no console errors. Then:

```bash
git add src/pages/reports/ReportBuilderPage.jsx src/hooks/useReports.js
# plus the service + routes + nav files you modified
git commit -m "$(cat <<'EOF'
feat(reports): custom report builder page with comparative + scheduling (FR-02.5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Lint + final verification

**Files:** none (verification only).

- [ ] **Step 1: Backend suite + drift**

Run: `cd vousfin-backend-main && npm test` → all green.
Run: `node scripts/ledgerDrift.js` → drift 0.

- [ ] **Step 2: Frontend lint + build**

Run: `cd vousfin-frontend-main && npm run lint` → clean.
Run: `npm run build` → succeeds.

- [ ] **Step 3: End-to-end smoke in preview**

Equity statement reconciles (green badge); revenue notes panel renders; report builder create → reorder → comparative preview → save → schedule → export all work; no console errors.

- [ ] **Step 4: Commit any lint fixes**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(reports): lint + verification for phase 5

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review (run against the spec)

- **Spec coverage:**
  - FR-02.4 equity statement → Tasks 1–2 (service, route, exports) + Task 10 (page). Reconciliation identity asserted in Task 1 test. ✓
  - FR-02.5 report builder → Tasks 4–7 (model, repo, service, routes) + Task 11 (page). Comparative absolute + % variance in Task 6 test. <5s budget = 1–3 aggregate queries + in-memory assembly. ✓
  - FR-02.5 scheduled delivery → Task 8 (cron + email attachment + `computeNextRun` test + server wiring). ✓
  - IFRS-15 notes → Task 3 (service) + Task 2 (route) + Task 10 (panel). Disaggregation = income-statement revenue asserted. ✓
  - No new deps; lightweight reorder; plain-language labels; reportCache reuse; tests under `tests/unit/<layer>/`. ✓
- **Placeholder scan:** all code steps contain complete code; PDF/Excel helper bodies describe the exact PDFKit/worksheet structure to mirror from existing `generateBalanceSheetPDF`/`generateExcelReport` (concrete, not "TODO"). Frontend page steps reference the concrete `BalanceSheetPage` pattern + exact field names. No TBD/TODO.
- **Type consistency:** `getStatementOfChangesInEquity`, `getRevenueNotes`, `getBalancesAsOf`, `renderTemplate`, `previewLayout`, `defaultLayoutFor`, `computeComparativeWindow`, `computeNextRun`, `runDueReports`, `scheduleReportDelivery`, repo `findOwned/findOwnedById/findScheduledDue`, controller `list/create/getOne/update/remove/render/preview/setSchedule/exportTemplate` — names are used identically across producing and consuming tasks. Output shapes (`rows[].values[componentKey]`, `rows[].current/prior/change/changePct`) match between service, controller, exports, and pages.
- **Ordering note:** Task 7 consumes `computeNextRun` from Task 8; the plan flags this and recommends implementing Task 8's pure `computeNextRun` first if executing strictly in isolation.

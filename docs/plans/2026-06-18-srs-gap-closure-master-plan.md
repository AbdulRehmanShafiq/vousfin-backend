# VousFin SRS Gap-Closure — Master Implementation Plan

> **For agentic workers:** This is a MASTER plan spanning multiple subsystems. Each phase below is a self-contained subsystem that should get its own granular TDD plan (via superpowers:writing-plans → subagent-driven-development) at execution time. Steps here are at component granularity with code/schema sketches, exact paths, and SRS-quoted acceptance criteria — enough to execute, decomposed further per phase.

**Goal:** Close the gaps between the current VousFin codebase and `VF-SRS-ACC-001 v1.0.0` so the platform satisfies every Functional (FR-01 → FR-10) and Non-Functional (NFR-PERF/SEC/REL/USE/COMP) requirement.

**Architecture:** Build on the existing, proven stack — Node.js/Express + MongoDB (Mongoose) backend in the `controller → service → repository → model` pattern, React 19 + Vite + TanStack Query + Zustand frontend, Gemini AI layer, and the Python forecasting platform. Every new domain follows the established conventions (BaseRepository, ApiError/ApiResponse, immutable AuditLog via `auditService.log`, state machines in `config/constants.js`, lazy-loaded `withSuspense()` pages, `nav.config.js`). No re-platforming.

**Tech Stack:** Node 20 / Express / Mongoose 9 / Jest · React 19 / Vite / Tailwind / TanStack Query / Zustand / react-hook-form + Zod · Gemini (text + vision) · Python forecasting microservice.

---

## 0. Architecture note — SRS vs. reality

The SRS §2.1/2.3 describes an *idealized* stack (FastAPI, PostgreSQL+pgvector, OpenAI GPT-4, TensorFlow). The **implemented** stack is Node/Express + MongoDB + Gemini + a Python forecasting service, which already satisfies the *functional intent* of every requirement it covers. **This plan builds on the implemented stack** and treats the SRS's named technologies as illustrative, not binding — the binding parts are the FR/NFR behaviours and acceptance criteria. (If a literal stack match is later required for academic grading, that is a separate re-platform effort and is explicitly out of scope here.)

---

## 1. Coverage matrix — does VousFin do all of it?

**No.** The core accounting spine, statements, tax, AR/AP, forecasting, anomaly detection, audit trail, AI advisory and health ratios are **done and strong**. ~12 sub-requirement areas are **gaps**. Status legend: ✅ Done · 🟡 Partial · ❌ Gap.

| FR | Requirement | Status | Evidence / what's missing |
|----|-------------|--------|---------------------------|
| FR-01.1 | Chart of Accounts (5-level) | ✅ | `ChartOfAccount.model`, `DEFAULT_ACCOUNTS` (78), `accountRepository`. Verify ≥5-level nesting + XLSX/PDF export. |
| FR-01.2 | Double-entry journal | ✅ | `JournalEntry`, debit=credit enforced, immutable, reversal. |
| FR-01.3 | General Ledger + Trial Balance | ✅ | `report.service.getTrialBalance`, GL views. |
| FR-01.4 | Period management | ✅ | `accountingPeriod.service` (close/lock/reopen) — Mongoose-9 hook bug fixed 2026-06-18. |
| FR-01.5 | Bank reconciliation | 🟡 | `bankReconciliation.service` auto-match ≥85% ✅; **CSV only — OFX/MT940 parsers missing**. |
| FR-02.1 | Income Statement | ✅ | `report.service.getIncomeStatement` + comparative. |
| FR-02.2 | Balance Sheet | ✅ | `getBalanceSheet` + comparative, A=L+E check. |
| FR-02.3 | Cash Flow (indirect) | ✅ | `getCashFlowStatement`. |
| FR-02.4 | Statement of Changes in Equity | ❌ | Year-end close to retained earnings exists; **no dedicated equity statement report**. |
| FR-02.5 | Custom/comparative report builder | ❌ | Comparative statements exist; **no drag-drop builder, no scheduled email delivery**. |
| FR-03.1–.4 | GST / WHT / Income Tax / FBR eFiling | ✅ | Full Tax Autopilot: `taxEngine`, `taxPosition`, `returnBuilders/{gst01,wht165,itReturn}`, `fbr/{fbrXmlExporter,fbrClient}`, `taxFilingCalendar`. |
| FR-04.1 | Budget creation/versioning/approval | ❌ | **No Budget model/service.** |
| FR-04.2 | Variance analysis + alerts | ❌ | **Depends on budget — gap.** |
| FR-04.3 | AI forecasting (ensemble) | ✅ | `services/forecasting/*` (ensemble, ETS, elasticNet, LSTM, conformal, champion-challenger, drift, explainability) — meets/exceeds spec. |
| FR-05.1 | Immutable audit trail | ✅ | `AuditLog` append-only, deletion refused, before/after snapshots. |
| FR-05.2 | Segregation of Duties | 🟡 | `approvalEngine` enforces creator≠approver ✅; **no configurable SoD conflict matrix at role-assignment level**. |
| FR-05.3 | AI anomaly detection | ✅ | `anomalyDetection.service`, `isolationForest.service`, exception queue. |
| FR-05.4 | Internal Audit Management | ❌ | Audit *trail* only; **no audit workspace (plans, sampling, findings, remediation)**. |
| FR-06.1 | Accounts Receivable lifecycle | ✅ | `invoice.service`, aging, DSO, dunning, write-offs. |
| FR-06.2 | Accounts Payable lifecycle | ✅ | `bill.service`, PO→GRN→Bill 3-way match. |
| FR-06.3 | 13-week cash flow forecast | 🟡 | `cashFlowForecast.service` exists; **13-week committed+probabilistic view + liquidity alert to confirm/extend**. |
| FR-06.4 | Dunning | ✅ | `dunning.service` ladder + Collector agent. |
| FR-07.1 | Cost/profit centers | 🟡 | `expenseAllocation.service` tags cost centers ✅; **no cost-center hierarchy mgmt + independent cost-center P&L**. |
| FR-07.2 | Job/product costing | ❌ | **Gap.** |
| FR-07.3 | Profitability analysis (multi-dim) | ❌ | Margin in health scoring only; **no by-customer/product/region/project P&L**. |
| FR-07.4 | Break-even / what-if | 🟡 | `scenarioModeler.service` for decisions; **no break-even engine**. |
| FR-08.1–.4 | Payroll (full) | ❌ | Only `PayrollAccrual` (tax provision stub). **No employee setup, gross-to-net run, payslips, EOBI/SESSI, bank file, salary tax certificates.** |
| FR-09.1 | Financial ratio dashboard | ✅ | `healthIndicators.service` (40+), `businessHealth.service`. |
| FR-09.2 | AI CFO advisory (NL, Urdu/Eng) | ✅ | `aiAssistant`, `financialQuery`, `cfoReport`, `narrative` (Urdu+Eng). |
| FR-09.3 | Industry benchmarking | ❌ | **Gap.** |
| FR-10.1 | Compliance calendar | 🟡 | `taxFilingCalendar` (tax+EOBI) ✅; **no full SECP/SBP 25-obligation calendar + multi-channel reminders**. |
| FR-10.2 | IFRS reporting (9/15/16, IAS 36) | 🟡 | IFRS-15 (`recognitionSchedule`) + IAS-21 FX ✅; **IFRS-16 leases, IAS-36 impairment, auto-drafted notes missing**. |
| FR-10.3 | AML/KYC screening | ❌ | **Gap.** |
| FR-10.4 | Document retention automation | 🟡 | Audit immutability ✅; **no retention-policy engine / archival / deletion-prevention for documents**. |

**NFRs:** RBAC ✅, JWT 15-min + refresh ✅, rate-limit ✅, tenant isolation ✅, helmet/compression ✅, immutable audit ✅, IFRS classification ✅, FBR XML ✅, multi-currency + FX ✅. **Gaps:** NFR-SEC-01 **MFA/TOTP** ❌, NFR-USE-01 **full Urdu UI (i18n)** ❌ (only narrative output is bilingual), NFR-USE-04 **WCAG 2.1 AA** 🟡 (unverified), NFR-USE-02 mobile 🟡 (responsive but unaudited), NFR-SEC-07 idle-session timeout 🟡, NFR-PERF formal load testing 🟡, NFR-REL backup/DR/failover = deployment-infra 🟡.

---

## 2. Phase sequencing & dependencies

Ordered so shared foundations land first and each phase ships working, testable software:

```
Phase 1  Cost-center dimension (first-class)        ← unblocks 4, 7, 8
Phase 2  Payroll module (FR-08)                      ← largest standalone
Phase 3  Budgeting & Variance (FR-04.1/.2)
Phase 4  Cost Accounting completion (FR-07.2/.3/.4)
Phase 5  Equity Statement + Report Builder + Notes (FR-02.4/.5, IFRS-15 notes)
Phase 6  Internal Audit Mgmt + SoD matrix (FR-05.4/.2)
Phase 7  Compliance & Governance (FR-10.1/.2/.3/.4)
Phase 8  Benchmarking + bank formats + 13-week cash (FR-09.3, 01.5, 06.3)
Phase 9  NFR hardening (MFA, Urdu i18n, WCAG, perf/security)
```

Each phase is independently shippable. Phases 2–9 only depend on Phase 1 where noted.

---

## Phase 1 — Cost-center dimension as a first-class tag

**FRs:** FR-07.1 (foundation). **Unblocks:** budget-by-department (FR-04.1), profitability (FR-07.3), payroll dept tagging (FR-08.3).

**Why first:** several phases need a real CostCenter entity + a reusable "tag any journal line with a cost center" mechanism. Today only `expenseAllocation` carries an ad-hoc `costCenterType/Id/Name` on bill lines.

**Files:**
- Create `models/CostCenter.model.js` — `{ businessId, code, name, type (department|branch|project|location), parentId, isActive }`, unique `(businessId, code)`, self-referential hierarchy.
- Create `repositories/costCenter.repository.js` (extends BaseRepository; `tree(businessId)`, `findByBusiness`).
- Create `services/costCenter.service.js` — CRUD + `getTree` + `validateAssignable`.
- Modify `models/JournalEntry.model.js` — add optional `costCenterId` on the entry and on each `journalLines[]` element (index `{businessId, costCenterId}`).
- Modify `services/transaction.service.js` `createTransaction` — accept + persist `costCenterId` (no behaviour change when absent).
- Create `controllers/costCenter.controller.js`, `routes/v1/costCenter.routes.js`; mount `/cost-centers` in `routes/index.js`.
- Frontend: `src/pages/settings/CostCentersPage.jsx` (tree CRUD), add `costCenterId` selector to the transaction form, register in `nav.config.js` + `routes.jsx` with `withSuspense()`.
- Tests: `tests/unit/services/costCenter.service.test.js`, extend transaction tests for the new field.

**Acceptance (SRS FR-07.1):** "All GL transactions can be tagged to one or more cost centers. Cost center P&L generated independently." (Independent P&L lands in Phase 4; tagging + hierarchy land here.)

**Task breakdown:** (1) CostCenter model + repo + unit test · (2) service CRUD + tree + test · (3) JournalEntry `costCenterId` + transaction.service persistence + test · (4) controller/routes + integration test · (5) frontend page + form selector + nav · (6) commit per task.

---

## Phase 2 — Payroll module (FR-08)

**FRs:** FR-08.1 employee/salary setup · FR-08.2 gross-to-net run · FR-08.3 payroll GL posting · FR-08.4 tax-on-salary + annual certificate. **Reuses:** `PayrollAccrual` (keep for tax provision), `transaction.service` for GL, EOBI/SESSI default accounts (already in `DEFAULT_ACCOUNTS` 2142/6192), `taxEngine` slab logic.

**Files:**
- Create `models/Employee.model.js` — profile: `{ businessId, code, fullName, cnic, ntn, designation, department(costCenterId), joiningDate, bankAccount, status }`; `salaryStructure[]` versioned `{ effectiveFrom, basic, allowances{houseRent,medical,conveyance,special}, taxExemptComponents, deductions[] }`.
- Create `models/PayrollRun.model.js` — `{ businessId, period(YYYY-MM), status(draft→processed→posted→paid), lines[] }`; each line = full gross-to-net snapshot `{ employeeId, gross, incomeTax, eobiEmployee, eobiEmployer, sessi, otherDeductions, netPay }`; `postedJournalEntryIds[]`. State machine in `config/constants.js` (`PAYROLL_RUN_STATUS`, `PAYROLL_RUN_TRANSITIONS`).
- Create `repositories/{employee,payrollRun}.repository.js`.
- Create `services/payroll.service.js` — `computeNetPay(employee, period, variablePay)` (pure, fixed-point), `processRun(businessId, period, actor)` (idempotent; locks on post), `postToGL(run)` (Dr Salary Expense / Cr Salary Payable; Dr Salary Payable / Cr Bank on payment; Dr Salary Expense / Cr EOBI Payable — tagged to `costCenterId` from `Employee.department`), `reverseRun`.
- Create `services/payrollTax.service.js` — annualized monthly WHT on salary per ITO 2001 slabs (reuse `taxEngine` rate tables), HRA exemption rule, year-end reconciliation, `generateSalaryCertificate(employeeId, fiscalYear)`.
- Create `utils/payslipPdf.util.js` (mirror `invoicePdf.service`), `utils/bankTransferFile.util.js` (NIFT/SBP CSV layout).
- Controllers/routes: `/payroll/employees`, `/payroll/runs`, `/payroll/runs/:id/process|post|payslips|bank-file`, `/payroll/certificates`. Mount `/payroll`.
- Frontend: `pages/payroll/{EmployeesPage,PayrollRunPage,PayslipsPage}.jsx`; nav group "Payroll".
- Background job `jobs/payrollReminder.job.js` (cron, month-end) — optional.
- Tests: `tests/unit/services/payroll.service.test.js` (net-pay math, GL balance = register), `payrollTax.service.test.js` (slab + HRA), integration for run→post→reverse.

**Acceptance (SRS FR-08.2/.3):** "Net Pay = Gross − Income Tax − EOBI Employee − SESSI − Other Deductions … Payroll locked after processing; amendments require reversal." "GL entries exactly match payroll register totals … cannot be manually edited; reversal required." Payslip PDF + NIFT bank file generated; annual salary tax certificate downloadable (FR-08.4). Performance: full run for 500 employees < 60s (NFR-PERF-04) — batch GL posting via `batchPosting.service`.

**Task breakdown:** Employee model+CRUD → salary structure versioning → `computeNetPay` pure function + slab tests → `processRun` idempotent → `postToGL` (balanced, cost-center tagged) → payslip PDF → bank file → annual certificate → frontend pages → perf check. Commit per task.

---

## Phase 3 — Budgeting & Variance (FR-04.1, FR-04.2)

**FRs:** FR-04.1 budget creation/versioning/approval · FR-04.2 variance analysis + threshold alerts. **Reuses:** `approvalEngine.service` (approval chain), GL actuals from `report.service`, `FinancialAlert` model + `businessEventEngine` for alerts, cost centers (Phase 1).

**Files:**
- Create `models/Budget.model.js` — `{ businessId, name, fiscalYearId, version, status(draft→pending_approval→active→archived), scenario(base|optimistic|pessimistic), lines[] }`; line = `{ accountId, costCenterId, period(monthly[12]), amount }`. Versions immutable once active.
- Create `repositories/budget.repository.js`, `services/budget.service.js` — create/clone-version, submit→approve (via `approvalEngine`), `getActive`.
- Create `services/variance.service.js` — `computeVariance(businessId, budgetId, period)` pulling GL actuals per account/cost-center: `variance = actual − budget` (sign-flipped for revenue), RAG status by config threshold; `checkBreaches` invoked on `JOURNAL_POSTED` event → emits alert within 60s (FR-04.2).
- Wire a subscriber in `services/eventSubscribers.service.js` for budget-breach alerts.
- Controllers/routes: `/budgets`, `/budgets/:id/versions|submit|approve`, `/budgets/:id/variance`. Mount `/budgets`.
- Frontend: `pages/budget/{BudgetEditorPage,VarianceDashboardPage}.jsx` — grid editor (account × month), RAG dashboard with drill-through to journal entries.
- Tests: `variance.service.test.js` (variance math + RAG + revenue sign flip), `budget.service.test.js` (versioning + approval gate).

**Acceptance (SRS FR-04.2):** "Variance = Actual − Budget (reversed for revenue). Alerts fire within 60 seconds of a GL posting that causes a threshold breach. Variance drillable to individual journal entries." (FR-04.1) "Budget entries version-controlled with full history. Approval chain configurable. Actuals auto-pulled from GL in real time."

---

## Phase 4 — Cost Accounting completion (FR-07.2, FR-07.3, FR-07.4)

**FRs:** FR-07.2 job/product costing · FR-07.3 multi-dimensional profitability · FR-07.4 break-even/what-if. **Depends on:** Phase 1 (cost centers), existing `InventoryItem`, GL.

**Files:**
- Create `models/Job.model.js` — `{ businessId, code, customerId, status(open→in_progress→completed), standardCost{material,labor,overhead}, actualCost{...}, costSheet[] }`; completed jobs transfer cost to Finished Goods/WIP via `transaction.service`.
- Create `services/jobCosting.service.js` — accumulate DM/DL/OH (absorbed at pre-determined rate or actual), `variance = actual − standard` split into material/labor/overhead; `completeJob` posts WIP→FG.
- Create `services/profitability.service.js` — `byDimension(businessId, dim ∈ {customer,product,region,salesperson,project}, period)` → contribution margin (`Revenue − Variable Costs`) + gross margin (`(Revenue−COGS)/Revenue`) per segment, flag loss-makers. Reuses GL + cost-center tags + invoice/customer/product joins.
- Create `services/breakEven.service.js` — `breakEvenPoint = fixedCosts / (price − variableCostPerUnit)` (units + revenue); `whatIf(params)` recomputes P&L impact in-memory without mutating data; scenarios persisted via existing `Scenario` model.
- Controllers/routes: `/jobs`, `/cost/profitability?dim=`, `/cost/break-even`, `/cost/what-if`. 
- Frontend: `pages/cost/{JobCostingPage,ProfitabilityPage,BreakEvenPage}.jsx` — profitability pivot/XLSX export, interactive what-if sliders.
- Tests: `jobCosting.service.test.js` (3 variances), `profitability.service.test.js` (CM/GM math + segment flagging), `breakEven.service.test.js` (BEP + what-if isolation).

**Acceptance (SRS FR-07.2/.3/.4):** "Material, Labor, Overhead variances reported separately. Completed jobs transfer cost to FG/WIP." "Contribution Margin = Revenue − Variable Costs … drillable … exportable to XLSX with pivot." "Break-Even = Fixed Costs / (Price − Variable Cost per Unit). What-if … without modifying actual data. Scenarios saveable and comparable."

---

## Phase 5 — Equity Statement + Custom Report Builder + IFRS-15 Notes (FR-02.4, FR-02.5)

**FRs:** FR-02.4 Statement of Changes in Equity · FR-02.5 custom/comparative report builder + scheduled delivery. **Reuses:** `report.service`, `cfoReport` PDF, `invoiceScheduler` cron pattern for scheduled email.

**Files:**
- Modify `services/report.service.js` — add `getStatementOfChangesInEquity(businessId, start, end)`: opening equity + net profit + capital injections − dividends ± adjustments = closing equity; reconciles with BS equity. + unit test asserting `Closing = Opening + NetProfit − Dividends ± Other`.
- Create `models/ReportTemplate.model.js` — `{ businessId, name, type(pl|bs|custom), layout[] (ordered account-group rows), filters{costCenterId,period}, comparativePeriods[] }`.
- Create `services/reportBuilder.service.js` — render a template against GL (custom P&L layouts, segment by cost center, side-by-side comparative with absolute + % variance columns); `< 5s` render budget (FR-02.5).
- Create `jobs/scheduledReport.job.js` — cron; daily/weekly/monthly auto-email of saved reports (reuse mailer + `cfoReport.renderPdf`).
- Controllers/routes: `/reports/equity`, `/reports/templates`, `/reports/templates/:id/render`, `/reports/templates/:id/schedule`.
- Frontend: `pages/reports/ReportBuilderPage.jsx` — drag-drop layout (dnd-kit), comparative toggle, schedule dialog.
- Tests: equity statement reconciliation test; report builder render + comparative variance test.

**Acceptance (SRS FR-02.4/.5):** "Closing Equity = Opening + Net Profit − Dividends ± Other Adjustments. Reconciles with BS equity." "Custom reports render < 5s. Comparative variance columns show absolute and percentage differences. Reports schedulable (daily/weekly/monthly auto-email)."

---

## Phase 6 — Internal Audit Management + SoD matrix (FR-05.4, FR-05.2 hardening)

**FRs:** FR-05.4 audit workspace · FR-05.2 configurable SoD conflict matrix. **Reuses:** immutable `AuditLog`, `approvalEngine`, RBAC roles.

**Files:**
- Create `models/AuditPlan.model.js` — `{ businessId, name, scope, period, sampleStrategy(random|risk_based), sampleSize, status }`.
- Create `models/AuditFinding.model.js` — `{ businessId, planId, linkedEntityType, linkedEntityId, observation, riskRating(critical|high|medium|low), managementResponse, targetResolutionDate, status(open|in_progress|resolved) }`.
- Create `services/internalAudit.service.js` — `drawSample(plan)` (random + risk-based using anomaly scores), `raiseFinding`, `recordResponse`, `agingReport` (open findings by age).
- Create `models/SodRule.model.js` + `services/sod.service.js` — conflict matrix `{ businessId, roleA, roleB, reason }`; `checkRoleAssignment(userId, newRole)` blocks conflicting combos **at assignment time** (not just transaction time); integrate into `admin.service` role-assignment + log violations to `AuditLog`.
- Controllers/routes: `/internal-audit/plans|findings`, `/sod/rules`. 
- Frontend: `pages/audit/{AuditPlansPage,FindingsPage}.jsx`, `pages/settings/SodMatrixPage.jsx`.
- Tests: `internalAudit.service.test.js` (sampling + aging), `sod.service.test.js` (conflict block at assignment).

**Acceptance (SRS FR-05.4/.2):** "Audit findings linked to specific transactions/processes. Management responses captured with target dates. Open findings dashboard with aging." "SoD conflicts defined by role pairs. System blocks conflicting combinations at the role assignment level … Unauthorized approval attempts logged."

---

## Phase 7 — Compliance & Governance (FR-10.1, FR-10.2, FR-10.3, FR-10.4)

**FRs:** FR-10.1 full compliance calendar · FR-10.2 IFRS-16 leases + IAS-36 impairment + notes · FR-10.3 AML/KYC · FR-10.4 document retention. **Reuses:** `taxFilingCalendar`, `recognitionSchedule` (IFRS-15), FX (IAS-21), `BillDocument`, daily cron.

**Files:**
- **FR-10.1** Modify `config/taxFilingCalendar.js` → generalize to `config/complianceCalendar.js` covering ≥25 obligations (FBR GST 15th, WHT, ITR, SECP annual return, EOBI/SESSI). Create `models/ComplianceObligation.model.js` (instance per business+period+status with reference number on completion). `jobs/complianceReminder.job.js` — 30/7/1-day multi-channel reminders (email + in-app `FinancialAlert` + WhatsApp adapter stub).
- **FR-10.2** Create `models/Lease.model.js` + `services/leaseAccounting.service.js` — IFRS-16 right-of-use asset + lease liability amortization schedule, monthly posting. Create `services/impairment.service.js` — IAS-36 indicator checklist + impairment loss posting. Create `services/notesToFinancials.service.js` — auto-draft notes from system data (accounting policies, fixed assets, leases, tax, related parties).
- **FR-10.3** Create `models/CounterpartyScreening.model.js` + `services/amlScreening.service.js` — screen new Customer/Vendor against FBR ATL + sanctions/FATF lists (daily-refreshed feed adapter), threshold (PKR 500k configurable) → enhanced scrutiny + mandatory justification capture; `draftSTR` for flagged. Hook into customer/vendor create.
- **FR-10.4** Create `services/retention.service.js` + `models/RetentionPolicy.model.js` — per-doc-type retention (7yr financial / 10yr corporate), block deletion within window, archival flag after 2yr, retrieval. Enforce on `BillDocument`/attachment delete paths.
- Controllers/routes for each; frontend `pages/compliance/{CalendarPage,LeasesPage,AmlPage}.jsx`.
- Tests per service (calendar coverage count, IFRS-16 amortization math, AML screen on create, retention deletion-block).

**Acceptance (SRS FR-10.1–.4):** calendar ≥25 obligations + 30/7/1-day reminders; "Revenue recognition 5-step IFRS-15 [done] … Lease liabilities per IFRS-16 amortization … Impairment per IAS-36"; "AML screening on every new counterparty … sanctions list daily … STR auto-draft"; "No financial document deletable within retention period … archival after 2 years."

---

## Phase 8 — Benchmarking, bank formats, 13-week cash (FR-09.3, FR-01.5, FR-06.3)

**Files:**
- **FR-09.3** Create `models/IndustryBenchmark.model.js` (curated SBP/SECP medians per sector/ratio) + `services/benchmarking.service.js` — compare business ratios (from `healthIndicators`) vs median, directional arrows, 8-ratio radar. Frontend `pages/analysis/BenchmarkingPage.jsx`.
- **FR-01.5** Create `utils/ofxParser.util.js` + `utils/mt940Parser.util.js`; wire into `bankReconciliation.service.parse` alongside CSV. Tests with sample OFX/MT940 fixtures.
- **FR-06.3** Enhance `cashFlowForecast.service` → explicit **13-week** rolling view = committed (scheduled `Payment`/`BillSchedule`/`InvoiceSchedule`) + probabilistic (historical AR collection + AP behaviour), daily refresh job, liquidity alert below configurable floor, drill-through. Frontend `pages/cash/ThirteenWeekPage.jsx`.

**Acceptance:** benchmark radar for 8 ratios; OFX/MT940 import auto-matches; 13-week forecast accuracy <10% on committed flows + liquidity alert (FR-06.3).

---

## Phase 9 — NFR hardening

**Files / work:**
- **NFR-SEC-01 MFA:** add `mfa{enabled,secret,backupCodes}` to `User.model`; `services/mfa.service.js` (TOTP via `otplib`); enforce on login for finance roles; `pages/settings/SecurityPage.jsx` enroll flow. Tests for verify/lockout.
- **NFR-USE-01 Urdu UI:** add `react-i18next`, extract strings to `src/locales/{en,ur}.json`, language switch in settings (the design-theme switcher already exists), RTL handling. (Narrative output already bilingual.)
- **NFR-SEC-07 idle timeout:** 15-min idle auto-logout in `useAuthStore` + server token TTL already 15-min.
- **NFR-USE-04 WCAG 2.1 AA:** audit with axe; fix contrast/aria/focus across the 4 themes.
- **NFR-USE-02 mobile:** responsive per-page audit (already noted open in design memory).
- **NFR-PERF:** load-test the statement/GL endpoints (k6) against the targets (P95 <3s @500K tx; statements <5s; GL search <2s @5M); add indexes/pagination where needed.
- **NFR-REL:** document/automate Atlas backups (30-day, PITR), DR runbook (RTO<4h/RPO<1h) — infra, not code.

**Acceptance:** MFA mandatory for finance roles; UI switchable EN/UR; axe AA pass; load tests meet PERF targets.

---

## 3. Self-review — spec coverage check

Every SRS requirement maps to a task: FR-01.* ✅ existing (OFX/MT940 → Phase 8); FR-02.1–.3 existing, FR-02.4/.5 → Phase 5; FR-03.* existing; FR-04.1/.2 → Phase 3, FR-04.3 existing; FR-05.1/.3 existing, FR-05.2 hardening + FR-05.4 → Phase 6; FR-06.1/.2/.4 existing, FR-06.3 → Phase 8; FR-07.1 → Phase 1, FR-07.2/.3/.4 → Phase 4; FR-08.* → Phase 2; FR-09.1/.2 existing, FR-09.3 → Phase 8; FR-10.1/.2/.3/.4 → Phase 7. NFR gaps (MFA, Urdu, WCAG, perf/rel) → Phase 9; remaining NFRs already satisfied (RBAC, JWT, rate-limit, tenant isolation, immutable audit, FBR XML, multi-currency). **No FR/NFR left unmapped.**

**Effort signal (rough, for sequencing only):** Phase 2 (Payroll) and Phase 7 (Compliance) are the largest; Phase 1 is small but unblocks others; Phases 3/4/5/6/8 are medium; Phase 9 is cross-cutting.

---

## 4. Execution model

Each phase above is a **subsystem**. At execution time, generate a granular per-phase TDD plan (failing test → minimal impl → pass → commit, per the writing-plans skill) and run it via subagent-driven-development. Recommended order: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9**, shipping and reviewing each phase before the next.

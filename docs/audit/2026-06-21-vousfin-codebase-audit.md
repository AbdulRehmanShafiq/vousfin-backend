# VousFin — Full-Stack ERP Audit

**Date:** 2026-06-21
**Auditor:** Claude Opus 4.8 (acting as full-stack ERP/accounting auditor)
**Scope:** `vousfin-backend-main` (Node/Express/Mongo) + `vousfin-frontend-main` (React/Vite)
**Method:** direct code inspection, grep/symbol sweeps, execution-path tracing, schema cross-checks. No README claims taken on faith.

---

## 0. Coverage honesty (read this first)

This codebase is large: **56 models, 104 backend services, 46 controllers, 26 repositories, 48 route files, 9 cron jobs, ~46k LOC in services+models alone**; frontend ~24 page areas, 36 API services, 27 hooks. A literal line-by-line read of all 104 services in one pass is not what happened, and claiming so would be dishonest.

What was **deep-audited end-to-end** (read in full + traced):
- The posting engine: `ledgerPosting.service.js`, `JournalEntry.model.js`
- The human-entry path: `transaction.service.js` (create guard, partial-payment settlement, balance update, reversal)
- FX journals: `journalGenerator.service.js`
- Ledger integrity: `ledgerIntegrity.service.js`
- Year-end close/open: `fiscalYear.service.js`
- Expense allocation: `expenseAllocation.service.js`
- Tax computation core: `taxEngine.service.js`
- Reports: `report.service.js` (income statement, balance sheet, equity, cash flow, trial balance, GL, revenue notes)
- Security baseline: route auth coverage across all 48 route files

What was **surveyed, not line-audited** (inventory + targeted greps only): AR/AP documents (`invoice.service` 1088 LOC, `bill.service` 873 LOC), procurement (PO/GRN/VendorCredit state machines), payroll (known-good from prior work), inventory, the AI/forecast/autonomy subsystem (20+ services), and the entire frontend beyond the reports area. Findings in those areas are flagged **(survey)** and need their own pass.

Every **VERIFIED** finding below cites `file:line`. Survey-level observations are labeled as such and not asserted as confirmed bugs.

---

## PHASE 1 — Repository map & architecture

### Backend architecture (verified)
`app.js` pipeline: helmet → CORS → compression → JSON → **passport (JWT)** → morgan → mongo-sanitize → rate-limit → routes → global error handler. Layer pattern `controller → service → repository → model` is followed consistently in the code read.

**Posting architecture (well-designed).** A single canonical poster `ledgerPosting.postCompoundJournal` ([ledgerPosting.service.js:118](services/ledgerPosting.service.js)) creates one balanced N-line `JournalEntry` and updates every line's cached `runningBalance` **atomically** via `withTransaction` (real all-or-nothing on a replica set; best-effort on standalone dev). It is **balanced-by-construction** (rejects Σdebit ≠ Σcredit, [:131](services/ledgerPosting.service.js)) and **idempotent** (`metadata.idempotencyKey`, [:136](services/ledgerPosting.service.js)). `postBalancedJournal` is a thin 2-line shim over it.

**Canonical journal-lines model.** `JournalEntry.journalLines[]` is the authoritative ledger effect; the top-level `(debitAccountId, creditAccountId, amount)` triple is a derived projection. Reports read through an `EFFECTIVE_LINES_STAGE` aggregation that uses `journalLines` if present, else synthesises the pair — so reports natively handle compound entries.

**Integrity guardrail.** `ledgerIntegrity.computeDrift` ([ledgerIntegrity.service.js:42](services/ledgerIntegrity.service.js)) compares cached `runningBalance` vs journal-derived balance; `recomputeBusinessBalances` repairs it and **refuses to write if the journal is unbalanced** ([:99](services/ledgerIntegrity.service.js)). Live drift is currently **0 across all 9 businesses** (verified by running `scripts/ledgerDrift.js`).

### Module inventory (56 models — abbreviated)
Core ledger: `ChartOfAccount`, `JournalEntry`, `Payment`, `InstallmentPlan`. AR/AP & docs: `Invoice`, `Bill`, `Customer`, `Vendor`, `CreditNote`, `VendorCredit`, `BillAllocation`, `RecognitionSchedule`. Procurement: `PurchaseOrder`, `GoodsReceipt`, `ProcurementAuditLog`. Periods/close: `FiscalYear`, `AccountingPeriod`. Tax: `TaxReturn`, `TaxPositionSnapshot`. Payroll: `Employee`, `PayrollRun`, `PayrollAccrual`. Budget/cost: `Budget`, `CostCenter`, `Job`. Reporting: `ReportTemplate`, `HealthSnapshot`. AI/forecast: `ForecastRun`, `ForecastAccuracy`, `ModelRegistry`, `Scenario`, `ProposedAction`, `AutonomyPolicy`, `EntityMemory`, `PlanRun`, `FeedbackEvent`, `EventLog`, `AnomalyAlert`, `FinancialAlert`. Infra: `User`, `Business`, `AuditLog`, `UsageMeter`, `CurrencyRate`, `SourceDocument`, `PendingTransaction`, `TransactionTemplate`.

### Background jobs (9, cron via `server.js`)
`anomalyScan`, `fxRateSync`, `paymentReminder`, `scheduledReport`, `taxReturnAutoPrepare`, `taxSnapshot`, `forecastAccuracy`, `forecastMaterialize`, `forecastRetrain`.

### AI/NLP subsystem (present; **survey only**)
Gemini-backed `nlParser/` (parserService, geminiService, journalGeneratorService), `aiAssistant`, `narrative`, `cfoReport`, `taxAdvisor`, `anomalyDetection`, `closeAgent`, `orchestrator`, `paymentsAgent`, `autonomyPolicy`, `forecasting/`. Note: `services/aiPlaceholder.service.js` exists — name implies a stub; **verify whether it is dead code**.

---

## PHASE 3 + 5 — Accounting-correctness findings (VERIFIED, with evidence)

### 🔴 P1-A1 — Expense allocation never posts to the General Ledger (silent failure)
**Files:** [expenseAllocation.service.js:127-155](services/expenseAllocation.service.js), [JournalEntry.model.js:44-101](models/JournalEntry.model.js); wired at `POST /expense-allocation` ([routes/index.js:75](routes/index.js)).
**Description:** `create()` builds a `JournalEntry.create({...})` using fields that **do not match the schema**: it passes `date`, `totalAmount`, `lines:[{accountId,debit,credit}]`, `referenceId`, `referenceType`. The model **requires** `transactionDate`, `amount` (min 0.01), `debitAccountId`, `creditAccountId`, `inputMethod` (all `required: true`) and the multi-line field is `journalLines:[{accountId,type,amount}]` — not `lines`. The create therefore throws a Mongoose `ValidationError`, which is swallowed by the surrounding `try/catch` that only does `logger.warn(...)` ([:152-154](services/expenseAllocation.service.js)). `summaryJournalId` stays `null`; the `BillAllocation` record persists but **no journal is ever posted and no running balance moves.**
**Why it matters:** The feature presents as "post a combined allocation journal entry" but has **zero ledger effect** for every bill, on every call. Cost-centre expense allocation is silently non-functional for accounting. No error surfaces to the user.
**Reproduction:** `POST /expense-allocation` for any bill → response succeeds (allocation saved) → query `JournalEntry` for that bill → none exists → trial balance unchanged.
**Root cause:** Raw `JournalEntry.create` with wrong field names, bypassing the canonical poster, inside a warn-only `try/catch`.
**Fix:** Post via `ledgerPosting.postCompoundJournal({ businessId, transactionDate, description, transactionType, inputMethod:'form', createdBy, lines:[...DR per cost-centre..., {accountId: ap, type:'credit', amount: total}] })`. Remove the swallow — let posting failures propagate. Add an integration test asserting a balanced JE is created and balances move.
**Confidence:** **High** (schema requireds vs payload fields are definitive; path is reachable).

### 🔴 P1-A2 — Unrealised FX revaluation posts the WRONG direction for payables (IAS 21)
**Files:** [journalGenerator.service.js:193-205](services/journalGenerator.service.js) (`runMonthEndRevaluation`); contrast the *realised* path [:94-97](services/journalGenerator.service.js).
**Description:** For month-end revaluation, `isGain = diff > 0` where `diff = currentBase − bookedBase`. The debit/credit assignment for AR and AP branches is **byte-for-byte identical** ([:198-205](services/journalGenerator.service.js)) and `isGain` is **not flipped for payables**. For an **asset (AR)** a rise in base value is a gain — correct. For a **liability (AP)** a rise in base value (you owe more) is a **loss**, but the code books it as a gain and debits the AP account (reducing the liability) instead of increasing it. The **realised** FX path explicitly flips polarity for payables (`if (!isReceivable) [debitId, creditId] = [creditId, debitId]`, [:95-97](services/journalGenerator.service.js)) — the unrealised path omits this, which is the smoking gun.
**Why it matters:** Foreign-currency payables are revalued backwards at month-end: FX losses are recorded as gains and the payable moves the wrong way. Overstates profit and understates liabilities under IAS 21 §23(a). **The drift checker will NOT catch this** — it only verifies cache == journal, and the (wrong) entry's balance update is internally consistent, so drift stays 0.
**Reproduction:** Foreign AP bill, closing rate higher than booking rate → run `runMonthEndRevaluation` → observe DR Accounts Payable / CR Unrealised FX (a "gain") when it should be DR Unrealised FX Loss / CR Accounts Payable.
**Root cause:** AR/AP gain-direction not differentiated in the unrealised branch.
**Fix:** For AP, invert: `const apIsGain = diff < 0;` and post `apIsGain ? (DR AP / CR Unrealised) : (DR Unrealised / CR AP)`. Mirror the realised path's polarity flip. Add unit tests for AR-gain, AR-loss, AP-gain, AP-loss.
**Confidence:** **High** (identical branches + missing flip vs the realised path that flips).

### 🟠 P1/P2-A3 — `reverseTransaction` is not atomic (drift / double-count on partial failure)
**Files:** [transaction.service.js:1241-1271](services/transaction.service.js).
**Description:** Reversal performs four independent, **un-sessioned** writes in sequence: (1) create reversal entry ([:1241](services/transaction.service.js)), (2) update account balances ([:1244-1251](services/transaction.service.js)), (3) adjust customer/vendor balances ([:1254-1262](services/transaction.service.js)), (4) mark the original `REVERSED` ([:1266-1271](services/transaction.service.js)). There is **no `withTransaction`**. By contrast `recordPartialPayment` wraps its unit in `withTransaction` ([:869-870](services/transaction.service.js)) and `editTransaction` uses `withTransaction` ([:1073](services/transaction.service.js)).
**Why it matters:** A crash/throw between steps leaves an inconsistent ledger: reversal posted + balances moved but original still `POSTED` (position double-reversed/counted), or original marked `REVERSED` without the balancing entry (trial-balance drift). `_updateAccountBalance` itself re-throws on failure ([:961](services/transaction.service.js)), so a mid-sequence balance error aborts after the reversal JE already exists.
**Reproduction:** Inject a failure in `partyBalanceService.adjustPayable` during a credit-purchase reversal → reversal JE + balance moves persist, original not marked reversed.
**Root cause:** Missing transaction wrapper on a multi-write accounting operation.
**Fix:** Wrap steps 1–7 in `withTransaction` (join caller `session` if provided), exactly like `recordPartialPayment`.
**Confidence:** **High** (absence of `withTransaction` is visible; sibling methods establish the expected pattern).

### 🟠 P2-A4 — FX journals are non-atomic (create then balance, no session)
**Files:** [journalGenerator.service.js:99-120](services/journalGenerator.service.js), [:207-234](services/journalGenerator.service.js), [:266-287](services/journalGenerator.service.js).
**Description:** Each FX entry does `JournalEntry.create({...})` then two separate `applyRunningBalance(...)` calls with **no session**. Balances are updated (so steady-state drift is 0), but a crash between the create and the balance updates drifts the trial balance. This bypasses the atomic guarantee `postCompoundJournal` exists to provide.
**Fix:** Route FX postings through `ledgerPosting.postCompoundJournal` (atomic + journalLines + idempotency) instead of raw create + manual balance.
**Confidence:** High.

### 🟠 P2-A5 — Realised FX entry has no idempotency key (double-post risk)
**Files:** [journalGenerator.service.js:62-125](services/journalGenerator.service.js) (`generateRealizedFxEntry`).
**Description:** Unlike `postCompoundJournal` (idempotent) and the unrealised path (which reverses priors before re-posting, [:254-292](services/journalGenerator.service.js)), realised FX has **no dedup**. If settlement is retried (network retry, re-run), the same realised gain/loss posts twice.
**Fix:** Pass an `idempotencyKey` derived from the settlement (e.g. `fx:realised:<parentId>:<settlementSeq>`) and post via the canonical poster.
**Confidence:** High.

### 🟠 P2-A6 — Settlement uses exact float equality (sub-cent dust never settles)
**Files:** [transaction.service.js:807](services/transaction.service.js), [:855-862](services/transaction.service.js).
**Description:** `recordPartialPayment` computes `newRemainingBalance = parent.remainingBalance - paymentData.amount` with **no rounding**, then branches on `newRemainingBalance === 0` and checks `parent.remainingBalance === 0` with strict equality. With fractional amounts (FX, split payments), floating-point residue (e.g. `1e-9`) makes a "paid in full" never reach exactly 0 → status stays `PARTIALLY_PAID`, the AR/AP line stays open with sub-cent dust.
**Why it matters:** Aging reports and outstanding-balance queries carry phantom open balances; "fully paid" invoices never flip to settled.
**Fix:** Round with `r2()` and compare with an epsilon (`Math.abs(newRemaining) < 0.005`). The model's pre-save normalises `remainingBalance <= 0 → PAID` ([JournalEntry.model.js:714-721](models/JournalEntry.model.js)) but not tiny **positive** residuals.
**Confidence:** High (no rounding on the subtraction; strict `=== 0`).

### 🟡 P2-A7 — Close/open/period-summary ignore compound `journalLines` (RE↔CYE mis-split, opening-balance gaps)
**Files:** [fiscalYear.service.js:377](services/fiscalYear.service.js), [:395](services/fiscalYear.service.js) (closing net income), [:539-545](services/fiscalYear.service.js) (`_computePeriodSummary`), [:653](services/fiscalYear.service.js) (opening balances `$group: { _id: '$creditAccountId' }`).
**Description:** These aggregations classify revenue/expense and compute opening balances using **top-level `debitAccountId`/`creditAccountId` only** — not the `EFFECTIVE_LINES_STAGE` the Income Statement/Balance Sheet/Trial Balance use. For businesses with **compound entries** (e.g. inventory sales whose COGS/revenue legs live only in `journalLines`), the year-end net income and opening balances are computed from an incomplete view. Equity *total* stays correct (the Balance Sheet's synthetic Current-Year-Earnings absorbs the remainder), but the **Retained-Earnings-vs-CYE split is wrong** and **opening balances for accounts that appear only in journalLines are missed**.
**Note (NOT a bug):** The closing entry posting itself — `DR <first Revenue account> / CR Retained Earnings` for net income, without zeroing nominal accounts — is **unconventional but self-consistent** with this system's report conventions (the Income Statement counts credit-only lines so it ignores the closing debit; the Balance Sheet's synthetic CYE = credit−debit so it sees it and nets to zero). Traced and confirmed correct for equity totals. Do **not** "fix" it to textbook closing without also changing the report conventions.
**Fix:** Use `EFFECTIVE_LINES_STAGE` for closing net income, period summary, and opening balances so compound entries are fully counted.
**Confidence:** High that the aggregation is top-level-only; Medium on real-world impact (depends on how many businesses use compound entries — inventory sales do).

### 🟡 P3-A8 — Year-end close can drive one revenue account negative
**Files:** [fiscalYear.service.js:418-459](services/fiscalYear.service.js).
**Description:** The single closing entry debits the **first** Revenue account by the **entire** net income, which routinely exceeds that one account's balance, leaving it with a negative (debit) balance. The trial balance still balances and equity is still correct (see A7 note), so this is cosmetic, but a revenue account showing a negative balance is confusing and could mislead drill-downs.
**Fix:** Post the closing debit against an Income Summary / `Current Year Earnings` clearing account (3310 exists in defaults) rather than an arbitrary revenue account.
**Confidence:** High (logic is explicit).

---

## PHASE 4 — Technical findings

### 🟢 Positives (verified)
- **Auth baseline solid:** every one of the 48 `routes/v1/*.routes.js` files applies `authMiddleware`/`requireBusiness`/passport (swept — zero unauthenticated route files); app-level `passport.initialize()` ([app.js:41](app.js)). `express-mongo-sanitize` + helmet + rate-limit present.
- **Tenant isolation on compound posts:** `createTransaction` validates every `journalLines[].accountId` belongs to the business ([transaction.service.js:115-126](services/transaction.service.js)) — closes a cross-tenant balance-update hole.
- **Guards:** idempotency ([:69-82](services/transaction.service.js)), double-submit guard ([:89-106](services/transaction.service.js)), cost-centre tag validation ([:128-134](services/transaction.service.js)).
- **Period immutability** enforced in model middleware on save/update/delete ([JournalEntry.model.js:686-777](models/JournalEntry.model.js)); `updateMany` is hard-blocked ([:775](models/JournalEntry.model.js)).
- **Money rounding** via `r2()` is consistent in the posters, integrity checker, tax engine, and reports.

### 🟡 P2-T1 — `JournalEntry` is not field-immutable after posting (survey/verified)
**Files:** [JournalEntry.model.js:745-769](models/JournalEntry.model.js).
The pre-update middleware enforces **period** locks only — it does not prevent changing `amount`/`debitAccountId`/`creditAccountId` on a **posted** entry in an **open** period via `findOneAndUpdate`. Reversals are the intended correction path, but nothing structurally prevents a silent in-place ledger edit (with a matching balance update it wouldn't even drift). Consider freezing financial fields post-post (allow only status/payment metadata), or document the reliance on the service layer.
**Confidence:** Medium-High.

### 🟡 P2-T2 — Per-save synchronous period lookup (performance)
**Files:** [JournalEntry.model.js:686-709](models/JournalEntry.model.js).
Every `.save()` runs `AccountingPeriod.findCoveringPeriod(...)` (a DB query) in `pre('save')`. On bulk posting (`createBulkTransactions`, batches of 10) this is an extra query per row. Acceptable for form entry; a hotspot for large imports. Consider caching the covering period per (business, month) within a batch.
**Confidence:** High (query is in the hook); impact scales with volume.

### 🟡 P3-T3 — Silent-swallow pattern is widespread (survey)
A sweep found **34** `catch` blocks across services that only `warn`/`continue`/ignore. Many are legitimately best-effort (cache invalidation, event emission). But the pattern hides real failures — **A1 (expense allocation) is the confirmed harmful instance.** Recommend an audit pass that classifies each: best-effort (keep) vs swallowing a write that matters (fix). Specifically re-check any `catch` wrapping a `JournalEntry.create`/posting/balance update.
**Confidence:** Pattern verified; individual severity varies.

### 🟡 P3-T4 — Raw `JournalEntry.create` outside the canonical poster (architecture)
**Files:** [journalGenerator.service.js:99,207,266](services/journalGenerator.service.js), [expenseAllocation.service.js:127](services/expenseAllocation.service.js).
The project's own rule (CLAUDE.md): "always go through a poster, never raw `JournalEntry.create`." These four sites violate it — causing A1 (malformed), A2/A4/A5 (FX). Routing them through `postCompoundJournal` would fix atomicity, idempotency, and journalLines consistency in one move.
**Confidence:** High.

### Test coverage (verified)
**162 suites / 1188 tests green**; only **6 integration suites** vs 156 unit. The accounting bugs above (A1, A2, A6) passed CI because unit tests mock the repositories/`getDebitCreditTotalsBetween` and never exercise the real schema-validation or real-data revenue conventions. **Recommendation:** add integration tests that post through the real model (would have caught A1's ValidationError) and FX revaluation tests for all four AR/AP × gain/loss quadrants (A2). The IFRS-15 notes vs P&L mismatch found earlier this session is the same class of gap (mock-passing, real-data-failing).

---

## PHASE 6 — Gap analysis (judgment; ✅ deep-audited, ◐ surveyed)

| Module | Implemented | Partial | Broken | Notes |
|---|---|---|---|---|
| ✅ Ledger posting engine | 100% | — | — | Atomic, balanced, idempotent. Exemplary. |
| ✅ Core transactions (create/settle/edit/reverse) | ~90% | reversal atomicity (A3), settlement float (A6) | — | Strong, two correctness gaps. |
| ✅ Reports (IS/BS/equity/CF/TB/GL/notes) | ~95% | — | — | Reconcile by construction; notes fixed this session. |
| ✅ FX (IAS 21) | ~70% | non-atomic (A4), no idempotency (A5) | **AP unrealised direction (A2)** | Realised path correct; unrealised AP wrong. |
| ✅ Fiscal year close/open | ~80% | compound-aware (A7), neg revenue (A8) | — | Equity totals correct; RE/CYE split + opening gaps. |
| ✅ Expense allocation | ~50% | — | **GL posting (A1)** | Records persist; ledger never updated. |
| ✅ Tax engine (compute) | ~90% | multi-tax stacking is one interpretation | — | Consistent rounding; reverse-charge present. |
| ◐ AR/AP documents (invoice/bill) | survey | — | — | 1088+873 LOC unread; projection pattern noted. |
| ◐ Procurement (PO/GRN/VC) | survey | — | — | State machines exist; not traced. |
| ◐ Payroll | ~known-good | — | — | Verified in prior work; not re-audited. |
| ◐ Inventory / installments / budgets / cost | survey | — | — | Models + services present; not traced. |
| ◐ AI/NLP/forecast/autonomy (20+ services) | survey | `aiPlaceholder` may be stub | — | Gemini-backed; needs its own audit. |
| ◐ Frontend (24 areas, 36 services) | survey | — | — | Only reports pages audited this session. |

**Headline:** the implemented accounting **core is strong and self-consistent**; the defects cluster in **peripheral posting paths that bypass the canonical poster** (expense allocation, FX) and in **multi-write atomicity** (reversal). Nothing found breaks the trial balance in steady state (drift = 0), but several issues mis-state profit/liabilities or fail silently.

---

## PHASE 7 — Final ranked report

### What is actually implemented
A genuinely substantial double-entry ERP: canonical atomic posting, compound journal lines, professional financial statements (incl. a reconciling equity statement and IFRS-15 notes), fiscal-year close/open, multi-currency with FX gain/loss, tax engine (GST/WHT/reverse-charge), AR/AP with settlement, procurement, payroll, budgeting, cost accounting, a custom report builder with scheduled delivery, and a large AI/forecast layer. Security baseline (auth, tenant isolation, sanitization, rate-limit) is in place.

### Ranked issues
- **P0 (critical):** none found that corrupt the trial balance in steady state. (Drift = 0 verified.)
- **P1 (high):**
  - **A1** Expense allocation posts nothing to the GL (silent ValidationError). 
  - **A2** Unrealised FX revaluation books payables backwards (IAS 21 — overstates profit, understates liabilities).
  - **A3** `reverseTransaction` non-atomic (drift/double-count on partial failure).
- **P2 (medium):** A4 FX non-atomic · A5 realised FX no idempotency · A6 settlement float-equality dust · A7 close/open ignore compound lines · T1 JE not field-immutable · T2 per-save period query.
- **P3 (low):** A8 close drives a revenue account negative · T3 silent-swallow pattern · T4 raw create bypasses poster.

### Answers to the seven questions
1. **Implemented?** Full double-entry core + statements + close/open + tax + FX + AR/AP + procurement + payroll + budgeting + report builder + AI layer.
2. **Incomplete?** FX revaluation (atomicity/idempotency), compound-aware close/open, field-level JE immutability.
3. **Broken?** Expense-allocation GL posting (A1, always); AP unrealised FX direction (A2).
4. **Missing?** Integration tests through the real model; FX revaluation test matrix; deep coverage of AI/frontend (not audited).
5. **Production-risky?** A3 (non-atomic reversal) under load/crash; A6 (phantom open AR/AP); the silent-swallow pattern hiding write failures.
6. **Violates accounting correctness?** A2 (IAS 21 payables), A1 (allocations never hit GL), A7 (RE/CYE split + opening balances for compound entries), A6 (settlement never completes).
7. **Fix first (order):** **A1 → A2 → A3** (the three with real money/correctness impact and clear fixes), then route all four raw-create sites through `postCompoundJournal` (kills A4/A5/T4 together), then A6, then A7.

### Recommended next audit passes (not done here)
1. AR/AP documents (`invoice.service`, `bill.service`) — projection/reconciliation correctness end-to-end.
2. Procurement state machines (PO→GRN→Bill, 3-way match tolerance).
3. AI/NLP subsystem — prompt-injection surface, grounding of `narrative`/`taxAdvisor`/`nlParser` outputs, and whether `aiPlaceholder.service.js` is dead code.
4. Frontend — error handling, money formatting, and the 36 API services vs backend contracts.

---

## FIXES APPLIED (2026-06-21, TDD — failing test first, then fix)

Full backend suite after fixes: **165 suites / 1201 tests green**; **ledger drift 0** across all 9 businesses.

| Finding | Status | Commit | Notes |
|---|---|---|---|
| **A1** expense allocation | ✅ FIXED | `dc11f69` | **Reframed during fix:** the bill already posts DR Expense/CR AP on approval (`bill.service.postApLiabilityJournal`), so "making it post" would have DOUBLE-counted. Correct fix = remove the broken double-posting block + silent swallow; allocation persists the cost-centre split only. Severity P1→P3. Regression test added (AP account present → no `JournalEntry.create`). |
| **A2** unrealised FX payables direction | ✅ FIXED | `6c2aa54` | Pure `buildUnrealisedFxRevaluation` helper, all 4 AR/AP × up/down quadrants unit-tested. IAS 21 corrected. |
| **A4** FX posting atomicity | ✅ FIXED | `6c2aa54` | Unrealised path now posts via `postCompoundJournal` (atomic + journalLines + idempotencyKey `fx:unrealised:<tx>:<revalDate>`). |
| **A5** realised FX idempotency | ⚪ MOOT | — | `generateRealizedFxEntry` is **dead code** (no callers). New lead: realised FX gain/loss on settlement appears **unwired** (potential missing feature, not a bug) — needs design. |
| **A6** settlement float dust | ✅ FIXED | `94a5a69` | Pure `computeSettlement` rounds + snaps `|remaining|<0.005` to fully-paid; unit-tested incl. the `0.1+0.2−0.3` case. |
| **A3 + A9** non-atomic multi-write | ✅ FIXED | `03065d6` | `reverseTransaction`, `creditNote.apply`, `vendorCredit.applyToBill` now wrap all writes in one `withTransaction` with the session threaded through; removed the swallowing try/catch in the credit-apply paths (missing accounts now throw → full rollback). Atomicity + regression tests across all three. |
| **A7** close/open ignore compound lines | ⏳ DEFERRED | — | Riskiest remaining (touches year-end close); equity TOTAL already correct (synthetic CYE absorbs), only RE↔CYE split + compound opening balances affected. Deserves its own pass with `EFFECTIVE_LINES_STAGE` refactor + close/reopen round-trip tests. |
| **A8/T1/T2/T3** | ⏳ DEFERRED | — | P3 cleanups (negative revenue on close, JE field-immutability, per-save period query, silent-swallow sweep — incl. the confirmed `bill.service:281-285` AP-journal swallow on approval). |

**New issues surfaced while fixing (added to backlog):**
- `bill.service.postApLiabilityJournal` failure on approval is **swallowed** ([bill.service.js:281-285](services/bill.service.js)) — a bill can be approved with no AP journal. Same class as the A9 swallows; fix by making approval+posting atomic or surfacing the error. (P2)
- Realised FX on foreign settlements appears unwired (A5 note). (P2 — feature gap)

---

## EXTENDED COVERAGE (second pass) — AR/AP docs, inventory, installments, AI, frontend

This pass deep-checked the areas previously marked **(survey)**. Net result: mostly **positive confirmations and downgrades**, plus **one new systemic finding (A9)** and **one correction**.

### New finding

#### 🟠 P2-A9 — Systemic: several multi-write money operations are not transaction-wrapped
**Files:** [transaction.service.js:1241-1271](services/transaction.service.js) (`reverseTransaction`, = A3), [creditNote.service.js:153-235](services/creditNote.service.js) (`apply`), [vendorCredit.service.js:128-173](services/vendorCredit.service.js) (`applyToBill`).
**Description:** These operations perform an ordered set of writes — document `save()` (invoice/bill/credit-note state), `postBalancedJournal(...)`, party-balance `adjustReceivable/adjustPayable`, and a final document `save()` — **without a wrapping `withTransaction`**. `postBalancedJournal` opens its *own* transaction for the JE + running balances, but the surrounding document-state and party-balance updates are **not joined to it**. A failure between any two steps leaves an inconsistent set: e.g. an invoice marked "credit applied" with no GL entry, or a JE posted but the customer's receivable not reduced.
**Why it matters:** Document state (Invoice/Bill/CreditNote/VendorCredit), the GL, and party balances can silently diverge under partial failure — exactly the cross-store inconsistency that the codebase elsewhere prevents. The correct pattern is already in `recordPartialPayment` ([:869-870](services/transaction.service.js)) and `editTransaction` ([:1073](services/transaction.service.js)).
**Fix:** Wrap each of these in `withTransaction`, passing the `session` through `postBalancedJournal({...}, { session })` and into the party-balance service (which already accepts `session`). `payment.service` shows an acceptable alternative (compensation/saga) if a single txn is impractical.
**Confidence:** **High** (write sequences are visible; no `withTransaction` present; sibling methods establish the pattern). This **supersedes/generalises A3** — fix all three together.

### Correction to first pass
- **`aiPlaceholder.service.js` is NOT dead code.** It is 297 LOC implementing `semanticSearch`, called by [ai.controller.js:162](controllers/ai.controller.js). The name is a misnomer (legacy). Withdraw the earlier "verify if dead" lead.

### Positive confirmations (verified — no defect)
- **AR/AP documents post correctly.** `invoice`, `bill`, `payment`, `creditNote`, `vendorCredit` all post via the **canonical poster** (`postBalancedJournal`/`postCompoundJournal`) — **zero raw `JournalEntry.create`** in these files. `invoice`/`bill` flows additionally use `withTransaction`.
- **Inventory valuation is correct.** [InventoryItem.model.js:133-145] `addStock` does proper weighted-average cost; `reduceStock` **blocks overselling** (`qty > currentStock` throws) and computes COGS = qty × weighted-avg cost, rounded. No negative-stock COGS leak.
- **`payment.service` uses a compensation/saga pattern** ([payment.service.js:116-118](services/payment.service.js)): each allocation is applied via the atomic `recordPartialPayment`, and `_compensate` rolls back on error. Materially safer than A3/A9 (which have neither txn nor compensation). *(Lead: verify `_compensate` covers the advance-journal case.)*
- **Installments are mature.** `createInstallmentPlan` delegates amortization to `InstallmentPlan.buildAmortization` (reducing-balance EMI, principal/interest split); a prior down-payment double-count bug is already fixed ([installment.service.js:176](services/installment.service.js)). *(Lead: confirm last-row residual absorption in `buildAmortization`.)*
- **AI/agent actions are governance-gated.** `nlControl`/`orchestrator` route through `autonomyPolicy.service` (queued for approval per the autonomy dial) rather than blind auto-posting to the ledger. *(Survey — not deep-traced; prompt-injection grounding of `narrative`/`taxAdvisor`/`nlParser` still merits its own pass.)*
- **Frontend money formatting is correct.** `formatCurrency` uses `Intl.NumberFormat('en-PK', …)` ([formatters.js:3-14]); API base `/api/v1` via Vite proxy with `VITE_API_BASE_URL` override.

### Updated gap analysis (revised rows)
| Module | Implemented | Issue |
|---|---|---|
| AR/AP documents (invoice/bill/payment/CN/VC) | ~90% | A9 atomicity on `creditNote.apply` & `vendorCredit.applyToBill` |
| Inventory valuation/COGS | ~95% | none (verify sale↔stock cross-txn atomicity as a lead) |
| Installments/loans | ~90% | none confirmed (lead: amortization residual) |
| AI/NLP/autonomy | survey+ | gated by autonomy; grounding pass still owed |
| Frontend (reports + money/api) | ~85% surveyed | nav double-highlight (prior); deep page audit still owed |

### Revised fix order (updated)
**A1 → A2 → A9 (incl. A3)** first — those are real money/correctness/consistency with contained fixes. Then route the four raw-create sites through `postCompoundJournal` (kills A4/A5/T4). Then A6 (settlement float), then A7 (compound-aware close/open).

### Still NOT audited (honest remaining gaps)
Procurement 3-way match (PO→GRN→Bill tolerance logic), the AI grounding/prompt-injection surface, payroll re-verification, budgeting/cost services internals, and the bulk of the frontend pages. These need a dedicated pass each — none are claimed as verified here.

---
*Evidence basis: all P1/P2 findings (A1, A2, A6, A9/A3, A4, A5, A7, T1, T2) cite verified `file:line`. Survey items and "leads" are labeled and are not confirmed defects. Drift = 0 and 162/1188 tests green were verified by execution this session. Second pass confirmed AR/AP canonical posting, inventory valuation, payment compensation, installment maturity, AI autonomy-gating, and frontend money formatting as sound.*

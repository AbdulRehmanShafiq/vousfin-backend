# Payroll Module (FR-08) — Design Spec

**Date:** 2026-06-18
**SRS:** VF-SRS-ACC-001 → FR-08 (FR-08.1 employee/salary setup · FR-08.2 gross-to-net run · FR-08.3 payroll GL posting · FR-08.4 tax-on-salary + annual certificate)
**Phase:** 2 of the SRS gap-closure master plan (`docs/plans/2026-06-18-srs-gap-closure-master-plan.md`)
**Builds on:** Phase 1 cost-centre dimension (employee → department → `costCenterId` tagging), the existing `taxEngine`, and the existing payroll chart-of-accounts entries.

---

## 1. Goal (plain language)

Let a business owner set up each employee once, then run payroll each month in a few clicks. The system works out every employee's take-home pay, the income tax to withhold, and EOBI / Provident-Fund contributions; posts one balanced journal entry to the books (tagged to the right department); and produces payslips, a bank-transfer file, and a year-end salary-tax certificate. Once a run is posted it is locked — corrections require a reversal, never an edit.

## 2. Decisions locked in brainstorming

| Question | Decision |
|---|---|
| Statutory deductions in v1 | **Income tax + EOBI (employee & employer) + Provident Fund + flexible configurable lines** for provincial social security (SESSI/PESSI) and any custom allowance/deduction. |
| Variable pay | **Fixed monthly structure + per-run manual adjustments** (overtime, bonus, loan/advance deduction, unpaid-leave days). No attendance/leave engine. |
| Salary income tax | **Annualize → salaried slabs → ÷12** (standard FBR method), using a tax-year-keyed slab table. |
| Per-province SESSI | **Configurable deduction line**, not hard-coded — owner enters their province's rate. No stale rate tables to maintain. |
| Gratuity (end-of-service) | **Deferred** — it is a service-period accrual, not part of monthly gross-to-net, and not required by FR-08. Employer-contribution structure left extensible so it can be added later. |

## 3. The pay math (one employee, one month) — the contract for `computeNetPay`

```
Gross        = basic + Σ allowances + Σ this-month additions (overtime, bonus, …)
Taxable      = Gross − Σ tax-exempt components (e.g. medical allowance up to the legal cap)
AnnualTax    = salariedSlabTax(Taxable × 12, taxYear)          # see §4
IncomeTax    = round(AnnualTax / 12)
NetPay       = Gross − IncomeTax − EOBI_employee − PF_employee − Σ otherDeductions
```

- **Pure & deterministic.** `computeNetPay(employee, period, variablePay)` takes a resolved salary-structure version + the run's manual adjustments and returns a fully-itemised line. No I/O. Fixed-point: every money value rounded to whole PKR (rupees) at the line level; the register total is the sum of rounded lines (no half-rupee drift).
- **Employer contributions are company cost, not deductions.** `EOBI_employer` and `PF_employer` are computed and expensed but do **not** reduce `NetPay`.
- **EOBI defaults (configurable per employee):** employee contribution and employer contribution are stored as fixed PKR amounts on the salary structure (Pakistan EOBI is a flat amount tied to minimum wage, not a % of actual salary). Defaults seeded but overridable.
- **PF (configurable per employee):** employee % of basic and employer % of basic; both default to 0 (off) unless the business runs a PF scheme.

## 4. Salary income tax — `payrollTax.service`

- New config `config/payrollTaxSlabs.js`: `SALARY_TAX_SLABS` keyed by Pakistan **tax year** (e.g. `'2025-26'`), each an ordered array of `{ upTo, fixed, rate }` brackets (progressive: tax = `fixed + rate × (income − lowerBound)`). Seed the current FBR salaried slabs; the table is data, easy to update each budget.
- `monthlySalaryTax(annualTaxable, taxYear)` → resolves the slab set, computes annual tax, returns `round(annual / 12)`. Throws `ApiError(400)` if no slab table for the year (with a clear "tax slabs for 2026-27 not configured yet" message).
- `generateSalaryCertificate(businessId, employeeId, taxYear)` → aggregates that employee's **posted** run lines across the tax year (gross, exempt, taxable, tax withheld) into a certificate payload for PDF (FR-08.4). Only posted/paid runs count.
- Tax-exempt cap logic (e.g. medical allowance exempt up to 10% of basic) lives here as a small pure helper, driven by the structure's `taxExempt` flags — kept conservative and explicit, not magic.

## 5. The books — `payroll.service.postToGL` (runs on **Post**)

> **Posting model note:** this codebase's `JournalEntry` is a **single debit + single credit pair** (`amount`, `debitAccountId`, `creditAccountId`) — there is no multi-line compound entry. So the compound entry below is **decomposed into a set of balanced Dr/Cr pairs**, posted via `transaction.service.createTransaction` (which already handles cost-centre tagging, idempotency, and ledger immutability). To keep it bounded for large runs (NFR-PERF-04) the lines are **aggregated by cost-centre** — not one entry per employee. So a run produces ~5 expense→payable pairs **per distinct cost-centre** plus the 2 employer-contribution pairs per cost-centre, not thousands. Per-employee detail lives in the `PayrollRun` snapshot (the register); the sum of the posted pairs equals the register totals.

Conceptually (the compound view), each expense leg **cost-centre tagged** from the employee's `department` (`costCenterId`), reusing existing default accounts:

```
Dr  6180  Wages & Salaries            (Σ gross)
Dr  6192  EOBI Contribution           (Σ employer EOBI)
Dr  6194  Provident Fund Contribution (Σ employer PF)
    Cr  2140  Wages Payable                       (Σ net pay)
    Cr  2141  Salary Tax Withheld Payable          (Σ income tax)   ← NEW default account
    Cr  2142  EOBI / Social Security Payable        (Σ employee + employer EOBI)
    Cr  2143  Provident Fund Payable                (Σ employee + employer PF)
    Cr  2148  Employee Benefits Payable             (Σ other deductions, incl. SESSI)
```

- **Invariant:** total debits = total credits = `Σ gross + Σ employer contributions`. A test asserts the posted JE balances **and** that its totals equal the payroll register totals (SRS FR-08.3: "GL entries exactly match payroll register totals").
- **On Pay** (`markPaid`): `Dr 2140 Wages Payable / Cr <bank account>` for the net total. The statutory payables (2141/2142/2143/2148) remain as liabilities until separately remitted — the live tax position already surfaces them.
- **New default account** `2141 Salary Tax Withheld Payable` (Liability / Current Liabilities / Credit) added to `DEFAULT_ACCOUNTS`; back-filled to existing businesses by the existing `accountRepository.syncMissingDefaults`.
- Each posted pair carries `transactionType: 'Salary'`, `inputMethod: 'batch'`, `transactionSource: 'system_generated'`, `metadata.idempotencyKey = 'pr:<runId>:<seq>'` (so a retried post never double-posts), and the group's `costCenterId`. The pairing decomposition (so the five credits each face a `6180` debit and the debits sum to gross):

```
per cost-centre group g (subtotals from the run snapshot):
  Dr 6180 / Cr 2140  = g.netPay
  Dr 6180 / Cr 2141  = g.incomeTax
  Dr 6180 / Cr 2142  = g.eobiEmployee
  Dr 6180 / Cr 2143  = g.pfEmployee
  Dr 6180 / Cr 2148  = g.otherDeductions
  Dr 6192 / Cr 2142  = g.eobiEmployer
  Dr 6194 / Cr 2143  = g.pfEmployer
(zero-amount pairs are skipped)
```
Total `6180` debits across all pairs = Σ gross; each pair is independently balanced.
- GL posting goes through `transaction.service` (system-generated source), so it is immutable like every other journal entry — "cannot be manually edited; reversal required" is satisfied by the existing ledger immutability. `reverseRun` loops `postedJournalEntryIds` and calls `transaction.service.reverseTransaction` for each.

## 6. State machine & locking (SRS: "locked after processing; amendments require reversal")

`PAYROLL_RUN_STATUS` + `PAYROLL_RUN_TRANSITIONS` in `config/constants.js`:

```
draft ──process──▶ processed ──post──▶ posted ──pay──▶ paid
  ▲                                       │
  └───────────────reverse◀────────────────┘   (posted|paid → reversed)
```

- `draft` → editable; building the run, adding adjustments.
- `processed` → numbers computed & frozen into `lines[]` snapshot; still pre-GL, can be reverted to draft.
- `posted` → GL written, **locked**. No edits.
- `paid` → bank disbursement recorded.
- `reverse` (from posted or paid) → writes a reversing journal entry via `transaction.service`, sets status `reversed`. Then a fresh run for the period can be created.
- Use the static `canTransition(from, to)` helper pattern (same as procurement domain) — never hard-code transitions in the service.
- **Idempotency:** unique index `{ businessId, period }` on non-reversed runs (period = `'YYYY-MM'`). `processRun` is safe to re-call while `draft`/`processed` (recomputes); refuses once `posted`. Re-posting is a no-op guarded by status.

## 7. Data models

### `models/Employee.model.js`
```
{ businessId, code (unique per business), fullName, cnic, ntn, email, phone,
  designation, department: costCenterId (ref CostCenter, optional),
  joiningDate, bankName, bankAccountTitle, iban, status: 'active'|'inactive',
  salaryStructure: [ {                       // VERSIONED — newest effectiveFrom ≤ period wins
      effectiveFrom: Date,
      basic: Number,
      allowances: { houseRent, medical, conveyance, special, other },
      taxExempt: { medicalCapPctOfBasic: Number },   // e.g. 10 → medical exempt up to 10% of basic
      eobi: { enabled: Bool, employeeAmount: Number, employerAmount: Number },
      providentFund: { enabled: Bool, employeePctOfBasic: Number, employerPctOfBasic: Number },
      recurringDeductions: [ { label, amount } ]      // e.g. SESSI, union due
  } ] }
```
- Versioned structure → a mid-year raise adds a new version; historical runs recompute against the version in force for their period (audit-safe). Helper `resolveStructure(employee, period)` picks the latest `effectiveFrom ≤ period-end`.

### `models/PayrollRun.model.js`
```
{ businessId, period: 'YYYY-MM', status,
  lines: [ {                                  // FULL immutable snapshot per employee
     employeeId, employeeCode, employeeName, costCenterId,
     basic, allowancesTotal, additions: [{label, amount}], gross,
     taxableIncome, incomeTax, eobiEmployee, eobiEmployer,
     pfEmployee, pfEmployer, otherDeductions: [{label, amount}], otherDeductionsTotal,
     netPay } ],
  totals: { gross, incomeTax, eobiEmployee, eobiEmployer, pfEmployee, pfEmployer, otherDeductions, netPay },
  postedJournalEntryIds: [ObjectId], reversalJournalEntryId,
  processedBy, processedAt, postedBy, postedAt, paidAt, bankAccountId }
```
- The snapshot is the source of truth for payslips, the register, the bank file, and certificates — never re-derived from the (possibly later-edited) employee record.

## 8. Services

- **`services/payroll.service.js`**
  - `computeNetPay(employee, period, variablePay)` — pure (§3).
  - `processRun(businessId, period, { employeeIds?, adjustments }, actor)` — resolves active employees, computes every line, writes/updates the `draft`/`processed` run snapshot. Idempotent.
  - `postToGL(runId, actor)` — builds the balanced compound entry (§5), tags cost-centres, transitions `processed → posted`, stores `postedJournalEntryIds`.
  - `markPaid(runId, bankAccountId, actor)` — net-pay disbursement entry, `posted → paid`.
  - `reverseRun(runId, actor)` — reversing entry, `→ reversed`.
  - `listRuns`, `getRun`, register/summary getters.
- **`services/payrollTax.service.js`** — §4.
- Both follow controller→service→repository→model, throw `ApiError`, and log via `auditService.log` on every state transition (before/after snapshot), consistent with the rest of the codebase.

## 9. Repositories

- `repositories/employee.repository.js` — extends `BaseRepository`; `findByBusiness`, `findByCode` (for dup-code 409 pre-check — `BaseRepository.create` swallows the 11000 code, same gotcha as cost-centres), `findActive`.
- `repositories/payrollRun.repository.js` — extends `BaseRepository`; `findByPeriod`, `findActiveByPeriod` (non-reversed, for the unique guard), `listByBusiness`.

## 10. Outputs

- `utils/payslipPdf.util.js` — per-employee payslip PDF from a run line (mirrors the existing `invoicePdf` util's pdfkit pattern). Shows earnings, deductions, employer contributions, net pay, period, employer/employee identifiers.
- `utils/bankTransferFile.util.js` — NIFT/SBP-style bank transfer CSV (account title, IBAN, amount, reference) for the net-pay total per employee. CSV only in v1 (no proprietary bank binary formats).
- Annual salary-tax certificate PDF (FR-08.4) — built from `generateSalaryCertificate` payload, same pdfkit util family.

## 11. API surface (`routes/v1/payroll.routes.js`, mounted `/payroll`)

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/payroll/employees` | list / create employee |
| GET/PATCH/DELETE | `/payroll/employees/:id` | read / update (adds salary version) / deactivate |
| GET/POST | `/payroll/runs` | list / create-draft for a period |
| GET | `/payroll/runs/:id` | run + register |
| POST | `/payroll/runs/:id/process` | compute lines |
| POST | `/payroll/runs/:id/post` | post to GL |
| POST | `/payroll/runs/:id/pay` | record disbursement |
| POST | `/payroll/runs/:id/reverse` | reverse a posted/paid run |
| GET | `/payroll/runs/:id/payslips` | payslip PDF(s) |
| GET | `/payroll/runs/:id/bank-file` | bank transfer CSV |
| GET | `/payroll/certificates/:employeeId/:taxYear` | annual salary-tax certificate PDF |

- Joi validation in `validations/payroll.validation.js` via `validate.middleware`. Schemas must explicitly list `costCenterId`, adjustment arrays, etc. (Joi strips unknown keys — the cost-centre lesson from Phase 1).

## 12. Frontend (React 19, lazy + `withSuspense`)

- `pages/payroll/EmployeesPage.jsx` — employee list + add/edit drawer with salary-structure form (basic, allowances, EOBI/PF toggles, recurring deductions, department picker reusing the cost-centre selector).
- `pages/payroll/PayrollRunPage.jsx` — pick a month → build run → per-employee adjustment grid (overtime/bonus/deduction/unpaid days) → **Review register** (totals, balanced-entry preview) → **Post** → **Pay**. Clear status pills and a one-click **Reverse** on posted runs.
- `pages/payroll/PayslipsPage.jsx` (or inline) — download payslips, bank file, certificates.
- `services/payroll.service.js` (frontend API wrapper), nav group **"Payroll"** in `nav.config.js`, routes in `routes.jsx`, all plain-language labels (no "WHT/EOBI" jargon as primary text — use "Income tax held back", "Pension (EOBI)", with the technical term secondary), per the product-copy plain-language rule.

## 13. Non-functional

- **Performance (NFR-PERF-04):** a 500-employee run posts in < 60 s. `postToGL` builds **one** compound journal entry (not 500), and `processRun` computes lines in memory then bulk-writes the snapshot — no per-employee DB round-trips in the hot loop. A perf smoke test asserts the single-entry posting path.
- **Auditability:** every transition logged via `auditService`; GL immutable; register ↔ GL equality enforced by test.
- **Idempotency & locking** as in §6.

## 14. Testing (TDD)

- `tests/unit/services/payroll.service.test.js` — `computeNetPay` math (gross, exempt, net), employer-vs-employee split, rounding; `postToGL` balanced + register-equals-GL; state-machine guards (can't edit posted, reverse path); idempotent `processRun`.
- `tests/unit/services/payrollTax.service.test.js` — slab boundaries (each bracket), annualize-÷12, missing-year error, medical-exempt cap, certificate aggregation over posted runs only.
- `tests/unit/repositories/*` — dup-code 409 pre-check, active-period guard.
- Integration: employee create → draft run → process → post (GL balanced) → pay → reverse (reversing entry) round-trip.
- Mock real models **without** `{ virtual: true }` (the flake rule).

## 15. Out of scope (v1)

Attendance/leave tracking & auto-proration, gratuity/end-of-service accrual, multiple concurrent pay frequencies (weekly/bi-weekly), proprietary per-bank binary transfer formats, employee self-service portal. All are additive later and the snapshot/structure design leaves room for them.

## 16. Build order (commit per task)

1. `2141` default account + `PAYROLL_RUN_STATUS`/`TRANSITIONS` + `SALARY_TAX_SLABS` config.
2. `Employee` model + repo + dup-code guard + CRUD (with salary-structure versioning).
3. `payrollTax.service` — slab tax (pure) + tests.
4. `computeNetPay` pure function + tests.
5. `PayrollRun` model + repo; `processRun` idempotent + tests.
6. `postToGL` — balanced, cost-centre tagged, register==GL + tests.
7. `markPaid` + `reverseRun` + tests.
8. Payslip PDF + bank-transfer CSV.
9. `generateSalaryCertificate` + certificate PDF.
10. Controllers/routes + Joi validation, mount `/payroll`.
11. Frontend pages + nav + routes.
12. Integration round-trip + 500-employee perf smoke.

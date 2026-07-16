# Core Accounting Engine — Deep Architectural Audit (2026-07-02)

Auditor role: Principal CPA / ERP architect / financial-systems auditor.
Scope: posting engine, JE lifecycle, GL, CoA, transaction engine, AR/AP, payments,
credits, bank reconciliation, inventory-GL, tax, reports, close, audit trail,
multi-tenant isolation. Benchmarked against SAP S/4HANA, Oracle Financials,
NetSuite, Dynamics 365, QuickBooks, Xero, Odoo conventions.

Baseline: all A1–A14/T1/T3 remediations from the 2026-06-21 audit verified still
in place. This audit found a **new layer of flaws** — mostly in status
conventions, multi-currency unit consistency, cross-object state sync, and
concurrency — that the previous pass did not reach.

Live-data check (read-only, Atlas): **zero reversal entries exist yet**, so the
Critical findings below are latent — fixable now with no data migration.

---

## Severity legend

- **P0 Critical** — financial statements or the open-item subledger become wrong.
- **P1 High** — integrity broken under a realistic path (concurrency, crash, routine op).
- **P2 Medium** — silent-failure or defense-in-depth gap; wrong under edge conditions.
- **P3 Low** — architectural debt / hardening.

---

## P0 — Critical

### F1. Reversal status convention misstates every financial statement
`transaction.repository.REPORT_STATUSES = [posted, partially_settled, settled]`
excludes `reversed`, but `reverseTransaction` marks the **original** `reversed`
and posts the **counter-entry** as `posted`. Result, for any reversal:
- Balance Sheet / Trial Balance / totals (getDebitCreditTotals): the original
  disappears while its flipped counter-entry stays → every as-of report is
  misstated by the full original amount (e.g. Cash −100 instead of 0).
- Income Statement uses a **gross convention** (revenue = credit lines only,
  expense = debit lines only) → a reversal's DR-Revenue line is *ignored*, so
  revenue reversals never reduce the P&L, and the reversed original silently
  vanishes from its historical period — retroactive mutation of closed-period
  reports (violates immutable-history).
- Ledger-integrity's BALANCE_STATUSES *does* count both (correct), so the drift
  script reads 0 while the statements are wrong — the guardrail can't see it.

**Why it matters:** reports must derive from the ledger; here they derive from a
subset that stops netting to zero the moment a reversal exists.
**Enterprise fix (SAP/Oracle convention):** reversed originals and their
counter-entries BOTH remain in reports (they net to zero, each in its own
period). Add `reversed` to REPORT_STATUSES (and the model statics); switch the
Income Statement to **net movement** per Revenue/Expense account with explicit
`entryType ∉ {closing, opening_balance}` exclusion (the gross convention was the
only thing excluding closing entries "naturally").

### F2. Multi-currency AR/AP: settlement, party balances and document posters disagree on units
- `createTransaction` books a foreign credit sale with `remainingBalance =
  baseAmount` (PKR) and party balance +base.
- `recordPartialPayment` treats `paymentData.amount` as **foreign** units
  (realised-FX math `foreignAmountSettled = amount`; the unit test's parent has
  `remainingBalance: 1000` for a 1000-USD invoice) but subtracts it raw from the
  **base** `remainingBalance` and from the party balance.
  → A USD 1,000 @280 invoice (remaining 280,000) paid with USD 1,000 leaves
  remaining 279,000; the invoice can never settle; customer balance is left
  overstated; VE-5 subledger reconcile breaks.
- `reverseTransaction` rolls party balances back by `original.amount`
  (**foreign**) though creation adjusted by base.
- Document-first posters (`invoice.postArJournal`, `creditNote.apply`,
  `vendorCredit`, write-off) pass foreign `amount` + `exchangeRate` to
  `postBalancedJournal`, which does **no FX conversion** → journal *lines* (and
  running balances) are posted in foreign units into a base-currency ledger;
  `creditNote.apply` even sets `baseCurrencyAmount: cn.totalAmount` (foreign).

**Fix:** one convention — the ledger, running balances, `remainingBalance` and
party balances are **always base currency**; the document keeps the foreign
face amount. Settlement converts the foreign payment at the **booking rate**
(`baseSettled = amount × bookingRate`) for the open-item/party math; realised FX
(already correct) books the rate difference. Poster callers must supply base-
currency lines (or amounts) with `baseCurrencyAmount` set explicitly.

### F3. Credit notes / vendor credits never reduce the recognition JE's open balance
`creditNote.apply` updates the Invoice document, the GL (DR Sales Returns / CR
AR) and the customer balance — but **not** `invoice.linkedJournalEntryId`'s
`remainingBalance`. Same for `vendorCredit.applyToBill`. Meanwhile:
- the payment engine validates and settles against the **JE's**
  `remainingBalance` → a fully-credited invoice can still be collected in full
  (AR driven negative);
- the M1 reconciler syncs the document **from** the JE after each payment →
  the credit's effect on the document can be silently erased;
- `computeArApSubledgerDrift` (VE-5/6) compares party balances (credited) to
  Σ JE.remainingBalance (not credited) → the integrity gate reports drift on
  every business with an applied credit note;
- the aging report reads JE.remainingBalance → overstated after credits.

**Fix:** applying (and cancelling) a credit adjusts the linked JE's
`remainingBalance`/`paymentStatus` in the same transaction, using the same
settlement invariants as payments.

---

## P1 — High

### F4. Reversing a settlement (payment) child never restores the parent open item
`reverseTransaction` has no `parentTransactionId` handling: reversing a
PAYMENT_RECEIVED/PAYMENT_MADE child flips the GL (AR/AP control restored) but
leaves the parent's `remainingBalance`/`partiallyPaidAmount`/`settlements` and
the customer/vendor balance untouched → control account ≠ open items ≠ party
balances. Worse: `payment.service._compensate` **relies on this path** to roll
back mid-apply failures — today compensation itself corrupts the subledger.
**Fix:** inside the reversal transaction, detect a settlement child and restore
the parent's settled state + party balance (or void via the payment engine).

### F5. Settlement / credit-apply concurrency: stale-read, blind-write
`recordPartialPayment` reads the parent, validates the over-payment guard, then
*sets precomputed* balances inside the txn. Two concurrent payments both pass
the guard and both set the same values → double cash, AR over-relieved, parent
shows a single payment. `withTransaction` uses the driver's retrying
`session.withTransaction`, and the creditNote/vendorCredit closures mutate
outer-scope documents (`invoice.totalCredited += …`) → a transient-error retry
**compounds** the increment. Payment multi-allocation is also not atomic across
allocations (documented as deferred; prod now runs a replica set, so it's due).
**Fix:** conditional update (`{_id, remainingBalance: <read value>}` → 409 on
miss) or re-read inside the transaction; make transaction closures re-entrant.

### F6. `createTransaction` side-effects escape the atomic unit
Party-balance adjustments (steps 6/7) and inventory mutations
(`reduceStock`/`applyPurchaseStock`, steps 7/7a) execute **before/outside** the
`withTransaction` that persists the JE (when no outer session). A failed persist
(validation, period lock, unbalance, infra) leaves customer/vendor balances and
physical stock moved with **no journal entry**. Both inventory functions already
accept a session — it just isn't threaded from this call site.
**Fix:** run validations up front; execute all writes inside the one unit.

### F7. Idempotency is check-then-insert with no unique index
Both `postCompoundJournal` and `createTransaction` guard on
`metadata.idempotencyKey` via `findOne` → insert. No unique index exists →
concurrent retries (double-click, network retry, cron overlap, serverless
double-invoke) double-post. Enterprise systems enforce document-number/idempotency
uniqueness at the DB level.
**Fix:** partial unique index `{businessId, 'metadata.idempotencyKey'}` (only
when the key is a string) + treat E11000 as idempotent-return.

### F8. Reversing a posted inventory sale/purchase never restores stock
`reverseTransaction` flips journal lines (GL inventory value restored) but never
calls inventory — `currentStock` stays reduced/increased → quantity subledger
permanently drifts from the GL inventory account (violates inventory-GL
lockstep).
**Fix:** reversal of an entry carrying `inventoryItemId/inventoryQty` must
restore stock in the same unit (or be blocked with a clear message directing to
an inventory adjustment).

### F9. Period locks block legitimate settlement of prior-period invoices
`checkPeriodLock` (pre findOneAndUpdate/updateOne) rejects **any** update to a
JE whose `transactionDate` is in a closed/locked period. Applying a March
payment to a January invoice must update the January JE's open-item fields
(`remainingBalance`, `paymentStatus`, `settlements`) → 403. So closing a period
freezes collection/payment of every open invoice in it — either operations halt
or users reopen periods (destroying the value of closing). In every enterprise
GL, closing blocks **postings**, not open-item clearing metadata.
**Fix:** the guards must allow settlement-metadata-only updates
(`remainingBalance`, `partiallyPaidAmount`, `paymentStatus`, `status`
posted→partially_settled/settled/reversed, `settlements`, `relatedTransactions`,
`metadata`) and keep blocking financial-field/date mutations and deletes.
(The same conflict makes `editTransaction`'s financial edits dead: the model's
`checkImmutability` 403s every amount/account edit the service believes it
sanctions — see F13.)

---

## P2 — Medium

### F10. FX-rate failure silently posts foreign amounts at 1:1
`createTransaction` catches `prepareFxFields` errors and "continues with raw
amount" → a USD transaction with a rate hiccup books USD units as PKR. Refuse to
post instead (or require an explicit caller-supplied rate).

### F11. Tax engine failures degrade silently
Engine errors are swallowed ("must never block a transaction") → taxable sales
post without tax, invisible until filing. Tax accounts are resolved by
accountName regex — a renamed account silently drops a tax line (an unbalanced
merge is caught by the balance check, i.e. hard 400s; a balanced drop simply
loses the tax). Resolve via `taxEngine.ensureTaxAccounts` account **codes**, and
surface engine failures (flag the entry for review instead of warn-log).

### F12. Unapplied-payment advance JE can silently skip
`_postUnappliedAdvance` warn-and-returns-null when account 2190/1160 is missing
→ received cash partially never reaches the GL while the Payment document shows
the full amount. Throw (rolling back the payment) or lazily create the account.

### F13. `editTransaction` is broken by design conflict — and would corrupt compound entries if it worked
The model hook `checkImmutability` (correct, enterprise behavior) blocks every
posted-entry financial edit that `editTransaction` still implements (reverse-old
/apply-new balance juggling). If the hook were relaxed, the service logic would
corrupt any compound entry (tax/COGS/FX): it rebalances only the top-level pair
and leaves `journalLines` stale (reports read the lines). Codify immutability:
service rejects financial edits with a clear "reverse and recreate" error;
delete the dead rebalance path; keep non-financial edits working.

### F14. Payment multi-allocation atomicity + compensation
See F5; additionally a process crash mid-apply leaves applied settlements with a
non-void Payment and no compensation. Wrap the whole apply in one transaction.

### F15. Cash-flow statement reads only top-level account pairs
`getCashFlowStatement` matches `debitAccountId/creditAccountId` — cash legs
inside compound `journalLines` (payroll runs, compound settlements) are invisible
or misread. Move it onto EFFECTIVE_LINES like the other statements.

### F16. Canonical poster does not validate tenant ownership of line accounts
`postCompoundJournal` trusts callers; `createTransaction` validates. A buggy
caller can post lines against another business's accounts AND move its running
balances. Add an ownership assertion in the poster (cheap: one query over the
distinct accountIds).

### F17. JE `deleteMany` unguarded
`updateMany` throws; `deleteOne`/`findOneAndDelete` check period locks;
`deleteMany` has no hook (no current callers — latent). Block it like
`updateMany`; keep `deletePermanent` service-internal.

---

## P3 — Low / debt

- **Locked-period admin override is dead code:** service allows override, model
  pre-save hook unconditionally blocks LOCKED — decide one way (recommend:
  override never allowed on LOCKED, allowed on CLOSED with role gate).
- `transactionRepository.bulkCreate` (raw `insertMany`, skips pre-save hooks and
  balances) has no callers — remove it before someone finds it.
- ~~`checkImmutability` doesn't restrict `transactionDate` moves within open
  periods on posted entries (report-period drift without audit annotation).~~
  **CLOSED 2026-07-16** (open-item authority closeout I-7): `transactionDate`
  added to the model's restricted fields; `editTransaction` rejects date
  changes up front with reverse-and-recreate guidance.
- Party-balance repo updates (`updateReceivableBalance`) are keyed by `_id` only
  — add businessId scoping for defense-in-depth.
- ~~Dual-write invoice/bill mirror failures are warn-only (doc/GL divergence is
  reconciled later by M1, but only after a payment event).~~ **CLOSED
  2026-07-16** (I-6): the mirror commits inside createTransaction's unit — a
  credit sale that cannot write its document does not post.
- ~~`markPaid` on a transaction-first invoice flips the document without touching
  the JE (doc/JE divergence until next sync).~~ **CLOSED 2026-07-16** (I-4/I-5):
  markPaid records a real Payment for the full remaining balance through
  payment.service — one settlement engine for both conventions; raw
  `/transition` flips to paid/cancelled/voided/written_off route through their
  proper flows.
- `getAccountTurnover` (model static) still reads top-level pairs only.
- `settlements[]` unbounded growth on hot AR/AP entries. **DEFERRED with
  design 2026-07-16** (spec §8.3): the array is load-bearing (detail UI,
  settlements endpoint, M9 rebuild, reversal cleanup, installments) — the
  follow-up is an append-only Settlement collection with dual-source reads,
  parity-checked backfill, then freeze.
- ~~No live-DB test exercises the real aggregation pipelines (all "integration"
  tests mock persistence) — F1 was invisible to 1,786 green tests.~~ **CLOSED**
  (accounting-correctness Phase 0): `tests/live/` real-mongod replica-set tier;
  it has since caught the unmocked-model GRN hangs, 7 phantom indexes, the
  invoice-first settlement fork, and the unique-JE-number E11000 landmine.

---

## Verification (this audit)

- Read-only production check: 0 reversal entries, 0 `status='reversed'` docs —
  F1/F4/F8 latent, no data repair needed if fixed now.
- All findings verified against current working-tree code (file/line refs in
  the session log).

## Implementation status (2026-07-02, same session — all TDD, red→green)

| Finding | Status | Where |
|---|---|---|
| **F1** reversal/report convention | ✅ FIXED | `REPORT_STATUSES` now includes `reversed` (repo + `getByAccount`); Income Statement = NET movement per account with explicit `entryType ∉ {closing, opening_balance}` exclusion. Tests: `transaction.repository.reversalReporting.test.js` |
| **F2** multi-currency settlement units | ✅ FIXED (both sides) | Settlement: foreign payments relieve `amount × bookingRate` of BASE open item; guard/settle/party all base; realised FX unchanged; reversal restore mirrors base (`recordPartialPayment.multiCurrency.test.js`). Document posters (pass 2): `utils/currency.util.toBaseAmount` — invoice AR recognition (+output tax), bill AP recognition (incl. base-to-base GRNI bound), credit notes, vendor credits, write-off, markPaid and the settlement journal all convert at the document's booking rate and pin `baseCurrencyAmount` (`documentPosting.baseCurrency.test.js`, foreign cases in `creditApplication.openItemSync.test.js`). |
| **F3** credits never reduced the recognition JE | ✅ FIXED | New `services/openItem.service.js` (guarded adjuster); wired into creditNote.apply/cancel, vendorCredit.applyToBill, invoice.writeOff. Tests: `openItem.service.test.js`, `creditApplication.openItemSync.test.js` |
| **F4** payment reversal didn't restore the parent | ✅ FIXED | `reverseTransaction` step 7a: restores remaining/paid/status, pulls the settlement, restores party balance (base-aware), skips reversed parents. Tests: `transaction.paymentReversal.test.js` |
| **F5** settlement double-pay race | ✅ FIXED | `updateTransactionGuarded` (optimistic match on the read `remainingBalance`) + 409 on a lost race; same pattern inside openItem.service. |
| **F6** createTransaction side-effects escaped the txn | ✅ FIXED | Party-balance + inventory writes deferred into the persist `withTransaction`. Tests: `transaction.createAtomicity.test.js` |
| **F7** no DB-level idempotency | ✅ FIXED | Unique partial index `idx_je_idempotency_key` (schema + migration `20260702-add-idempotency-unique-index.js` — **run migrate-mongo on deploy**); poster translates E11000 into idempotent-return. Tests: `ledgerPosting.idempotencyRace.test.js` |
| **F8** inventory stock not restored on reversal | ✅ FIXED (pass 2) | `reverseTransaction` step 7b: sale reversals restore stock at the ORIGINAL COGS unit cost (derived from the entry's inventory credit leg; falls back to current cost for legacy entries); purchase reversals remove the quantity through the normal costing method (insufficient stock → whole reversal rolls back). Tests: `transaction.inventoryReversal.test.js` |
| **F9** period locks froze settlement of prior-period invoices | ✅ FIXED | Settlement-metadata allowlist (`isSettlementMetadataOnlyUpdate`, status restricted to the settlement lifecycle, `$setOnInsert` ignored) bypasses the period-lock query hooks; financial fields/dates/deletes still blocked. Tests: `journalEntry.settlementPeriodLock.test.js` |
| **F10** FX failure posted foreign at 1:1 | ✅ FIXED | Fail-closed 400. Tests: `transaction.fxFailClosed.test.js` |
| **F11** tax engine silent degradation | ✅ FIXED (pass 2) | `taxEngine.resolveTaxAccountId` resolves name → profile CODE → self-heal seed; unresolvable tax lines and engine errors now REFUSE the posting (fail closed) instead of posting untaxed. Tests: `taxEngine.resolveAccount.test.js`, `transaction.taxFailClosed.test.js` |
| **F12** unapplied advance silently skipped | ✅ FIXED | Throws 500; payment compensation voids the payment. Tests: `payment.unappliedAdvance.test.js` |
| **F13** editTransaction vs model immutability conflict | ✅ FIXED | Financial edits rejected up front with reverse-and-recreate guidance; dead rebalance path (which would corrupt compound entries) removed. Tests: `transaction.editImmutability.test.js` |
| **F14** payment multi-allocation atomicity | ✅ FIXED (pass 2) | `recordPayment` wraps every allocation + the on-account advance + the Payment save in ONE `withTransaction` (re-entrant for driver retries); compensation reversals now run only on the standalone-Mongo fallback where no real transaction rolled things back. Tests: `payment.atomicity.test.js` |
| **F15** cash flow reads top-level pairs only | ✅ FIXED (pass 2) | New `transactionRepository.getCashLineTotals` (EFFECTIVE_LINES, reversals net, cash→cash transfers cancel); `getCashFlowStatement` classifies line-level net cash per type. Tests: `report.cashFlow.effectiveLines.test.js`, `transaction.repository.cashLines.test.js` |
| **F16** poster tenant guard | ✅ FIXED | Bulk ownership check for every line account. Tests: `ledgerPosting.tenantGuard.test.js` |
| **F17** JE deleteMany unguarded | ✅ FIXED | Blocked like updateMany. |

**Verification:** full backend suite green after both passes (269 suites /
1,868 tests at final count); live ledger drift 0 across all businesses,
journals balanced, AR/AP subledger reconciled (read-only checks after each
pass). Behavioural note from pass 2: tax now fails CLOSED — unit suites that
exercise `createTransaction` must stub `taxEngine.isTaxEnabled` (the legacy
suite was updated accordingly).

**Deploy notes:** run `migrate-mongo up` (new unique index). Behaviour changes
to announce: financial edits of posted entries now return a clear
reverse-and-recreate error (they previously failed with a confusing 403);
foreign-currency transactions without a resolvable rate are refused instead of
posting 1:1; payments with an unapplied portion fail if the advance account is
missing.

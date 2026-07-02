# PR: fix(accounting): close 17 core-engine integrity findings (2026-07-02 audit)

Base: `main` ← Head: `audit/core-accounting-engine-2026-07`

Create at: https://github.com/AbdulRehmanShafiq/vousfin-backend/pull/new/audit/core-accounting-engine-2026-07

---

## Summary

Deep architectural audit of the core accounting engine (double-entry posting, journal-entry lifecycle, AR/AP, payments, credits, inventory↔GL, tax, FX, reports, period locks), benchmarked against enterprise ERP conventions. **All 17 findings (F1–F17) are fixed, test-first.**

Full report: `docs/audit/2026-07-02-core-accounting-engine-audit.md`.

**Verification:** 269 suites / 1,868 tests green; live ledger drift 0 across all businesses, journals balanced, AR/AP subledgers reconciled.

## Critical (financial statements / open-item subledger were wrong)

- **F1 — reversals misstated every statement.** `REPORT_STATUSES` now includes `reversed` (pairs net to zero); Income Statement is net movement per account with explicit closing/opening-balance exclusion. (No reversals in prod yet — latent, no data repair.)
- **F2 — foreign AR/AP could never settle.** One base-currency convention across the settlement engine and the document posters via `utils/currency.util.toBaseAmount` + pinned `baseCurrencyAmount`.
- **F3 — credits never reduced the recognition JE's open balance.** New `services/openItem.service` syncs the JE on credit-note apply/cancel, vendor-credit application and write-off.

## High / medium

F4 payment-reversal parent restore · F5 optimistic settlement guard · F6 createTransaction atomicity · F7 DB idempotency index (+migration) · F8 stock restored on reversal · F9 settlement clears through locked periods · F10 FX fail-closed · F11 tax code-resolve + fail-closed · F12 unapplied advance throws · F13 posted-entry immutability · F14 payment one-transaction · F15 cash-flow effective lines · F16 poster tenant guard · F17 JE deleteMany blocked.

## Deploy notes

- Run `migrate-mongo up` — new unique index `idx_je_idempotency_key`.
- Three paths now return clear errors instead of silently posting: posted-amount edits, unresolvable FX rates, tax-calculation failures.

## Still open (minor / design-level)

Dual invoice-document/ledger-entry lifecycle consolidation; debit-note GL entry; locked-period admin-override RBAC decision; live-DB tests for report aggregation pipelines.

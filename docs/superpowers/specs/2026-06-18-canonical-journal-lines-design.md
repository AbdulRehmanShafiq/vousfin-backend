# Canonical Journal Lines — Design Spec

**Date:** 2026-06-18
**Scope chosen:** Full canonical-lines program (single source of truth for the ledger) — strangler-fig rollout with the historical data migration fenced last and gated.
**Relates to:** the gated "enterprise-integrity remediation Track 2" (immutable JE, collapse duplicate balances, atomic writes). This is that track, made concrete.

---

## 1. Problem (root cause)

The ledger has **two divergent write primitives**, and the compound-journal capability is trapped inside the human-entry one:

- `transaction.service.createTransaction` — supports compound `journalLines[]` (writes one entry with N lines, updates running balance per line, reverses compound correctly) **but** bundles human-entry enrichment (auto-tax, auto-FX, type inference, double-submit guard) and has a split idempotency contract (top-level `idempotencyKey` vs `metadata.idempotencyKey`).
- `ledgerPosting.postBalancedJournal` — clean system poster, atomic, **but hard-wired to exactly 2 accounts**; ignores `journalLines`.

The read side is already compound-aware: `transaction.repository.EFFECTIVE_LINES_STAGE` normalizes every entry to lines (`journalLines` if present, else a synthesized debit/credit pair); all three financial statements read through it.

**Consequences:** every multi-account feature improvises. Payroll decomposed one logical run into 7×N pair-entries with a `metadata.idempotencyKey` grouping prefix; close uses `closingBatchId`; AR/AP uses `projectionOf` + `parentTransactionId`/`relatedTransactions`. The `skipTax`/idempotency workarounds in payroll are the toll for routing a system posting through the human-entry god-function.

**No live corruption today:** the only writer of `journalLines` (the tax engine) flows through `createTransaction`, which updates per-line balances. Nothing routes `journalLines` through the 2-account poster, so the trial balance is not currently drifting. This is an architecture fault, not an active data bug.

Also note: the existing balance recompute `transaction.service.recalculateAccountBalance` is **pair-only** (ignores `journalLines`) — it must become compound-aware as part of this work.

## 2. Goal & the invariant

**Goal:** make `journalLines[]` the single, authoritative representation of every journal entry's ledger effect, written through ONE canonical poster, with running balances always derivable from (and kept in lock-step with) the lines.

**The invariant (new system rule):**
> Every JournalEntry has a balanced `journalLines[]` (Σ debit amounts = Σ credit amounts, ≥ 2 lines). The top-level `(debitAccountId, creditAccountId, amount)` triple is a **derived denormalized projection** of those lines (representative first-debit / first-credit, amount = Σ debits), kept ONLY for backward-compatibility and existing indexes — never the source of truth. Cached `ChartOfAccount.runningBalance` equals the sum of that account's effective lines across all non-archived posted entries, at all times.

## 3. Non-goals

- No change to the financial-statement read path (`effectiveLines` already correct).
- No new accounting behavior; this is representational unification + integrity.
- Not removing the `(debitAccountId, creditAccountId, amount)` fields — they stay as a derived projection (indexes, AR/AP queries, legacy consumers depend on them).
- Not touching tax/FX *calculation* logic — only *where* the resulting lines are posted.

## 4. Canonical poster — `ledgerPosting.postCompoundJournal`

New home: extend `ledgerPosting.service.js` (already the "shared balanced-journal poster" with the atomic `withTransaction` wrapper).

```
postCompoundJournal(payload, { session, updateBalances = true })
  payload = {
    businessId, transactionDate, description, transactionType, inputMethod,
    createdBy, transactionSource, entryType,
    lines: [ { accountId, type:'debit'|'credit', amount, costCenterId?, description? } ],
    idempotencyKey?,            // canonical: stored at metadata.idempotencyKey; dedup before write
    costCenterId?, periodId?, fiscalYearId?, ...passthrough metadata
  }
```

Responsibilities (all inside one transaction):
1. **Validate:** ≥ 2 lines; every amount > 0; `round(Σ debit) === round(Σ credit)` (else `ApiError(400, 'Journal is not balanced')`); all `accountId`s owned by `businessId` (tenant isolation); all `costCenterId`s active+owned (reuse `costCenterService.validateAssignable`).
2. **Idempotency (unified):** if `idempotencyKey`, look up existing `{ businessId, 'metadata.idempotencyKey': key }`; if found, return it (no double-post). Store the key at `metadata.idempotencyKey`.
3. **Derive the projection:** `debitAccountId` = first debit line's account, `creditAccountId` = first credit line's account, `amount` = `round(Σ debit)`. Persist `journalLines = lines`.
4. **Persist** one JournalEntry (`JournalEntry.create([entry], { session })`).
5. **Balances:** for EVERY line, `applyRunningBalance(line.accountId, line.amount, line.type, { session, strict: !!session })`. (Generalize the existing helper over an array — it already does the normal-balance sign rule.)
6. **No enrichment:** never calls the tax engine, FX, type inference, or the double-submit guard. The system caller supplies exact lines. (This structurally removes the need for `skipTax`.)
7. Returns the created JournalEntry.

A thin `postBalancedJournal(entry)` (2-account) is **kept as a back-compat shim** that builds a 2-line `lines[]` and delegates to `postCompoundJournal`, so existing callers are unchanged.

Reversal: `reverseCompoundJournal(entryId, businessId, { reversalDate, reason }, actor, { session })` — loads the entry, writes ONE reversal entry whose `lines` are the originals with `type` flipped, links `reversalOf`, updates balances per line. (The current `reverseTransaction` already flips compound `journalLines` at 1217–1236; this is the system-lane equivalent.)

## 5. Convergence — both write paths express entries as lines

- `createTransaction` keeps its human-entry enrichment, but at the **persistence step** it builds a full balanced `lines[]` (it already assembles `entryData.journalLines` for tax/compound — make that unconditional so even a plain 2-account entry stores its 2 lines) and posts via the same per-line balance update it already has (656–658). Net effect: **every new entry, from every path, carries `journalLines`.**
- `recalculateAccountBalance` becomes compound-aware: recompute from the `effectiveLines` aggregation (sum per account over `journalLines`-or-synthesized-pair), not the top-level pair. One shared helper `journalDerivedBalance(businessId, accountId)`.

## 6. Drift verifier (read-only safety net) — `ledgerIntegrity.service`

`computeDrift(businessId)`:
- For every account, compute `journalDerived` (sum of effective lines across non-archived posted entries) and compare to cached `runningBalance`.
- Returns `{ accounts:[{accountId, code, cached, derived, drift}], totalDrift, balanced: Σdebits==Σcredits }`.
- **Pure read.** Safe to run on production anytime. This is the gate before and after every migration step, and a candidate for a scheduled health check.

Exposed as an admin/maintenance route + a CLI script (`scripts/ledgerDrift.js`).

## 7. Historical data migration (FENCED — last, gated) — `migrations/backfill_journal_lines.js`

Runs only after Phases 1–4 are in and the verifier is trusted. Migrate-mongo migration, idempotent, dry-run first.

1. **Backfill `journalLines`** on every historical entry that lacks them: set `journalLines = [ {debit pair}, {credit pair} ]` from the existing triple. (Pure denormalization — no balance change, since effectiveLines already synthesized the same pair. This makes the lines the literal stored truth.)
2. **Recompute running balances** for every account from the journal (compound-aware) and write them.
3. **Verify:** run `computeDrift`; assert `totalDrift === 0` and balanced. Abort + report if not.

Safety: dry-run mode prints the drift report and the would-be balance changes without writing; requires an explicit `--apply` + a confirmation token; runs inside a transaction on the replica set (Atlas); fully re-runnable; a `down()` is unnecessary (backfill is non-destructive, balances are recomputable). **Not run by me without explicit per-run user confirmation** (it writes real businesses' books).

## 8. Rollout phases (strangler-fig; each independently shippable & test-green)

- **Phase 0 — Drift verifier** (`ledgerIntegrity.service` + `scripts/ledgerDrift.js`). Read-only. Establishes the baseline (expect ~0 drift today) and the guardrail. **No risk.**
- **Phase 1 — `postCompoundJournal`** in `ledgerPosting` (+ generalize `applyRunningBalance` over lines, + `postBalancedJournal` shim, + `reverseCompoundJournal`). Additive; unit-tested. Existing callers unchanged.
- **Phase 2 — Converge writes:** `createTransaction` always persists `journalLines`; `recalculateAccountBalance` becomes compound-aware via the shared helper. Run the verifier after → drift still 0.
- **Phase 3 — Move features onto the poster:** payroll `postToGL` → ONE compound entry per run (lines tagged per `costCenterId`), reversal in one call (drop `skipTax`/manual idempotency). Then close + revenue recognition + any decompose-into-pairs flows. Each: refactor → unit tests → live smoke → verifier drift 0.
- **Phase 4 — Make lines canonical for reads-that-still-use-the-pair:** audit any consumer reading `debitAccountId/creditAccountId/amount` for *accounting truth* (vs. indexing/AR-AP filters) and point it at effective lines. Leave the projection fields for indexes/AR-AP.
- **Phase 5 — Historical migration (gated):** §7. Dry-run → drift report → explicit go-ahead → `--apply` on the replica set → verify drift 0.
- **Phase 6 — Retire dead 2-account special-cases** where safe; document the projection-field contract in CLAUDE.md.

Phases 0–3 deliver essentially all the functional value (clean primitive + payroll/close/recognition unified) at low risk. Phases 5–6 are the "single source of truth" closure and carry the data risk — fenced and gated.

## 9. Testing

- Poster unit tests: balanced-validation rejects unbalanced lines; per-line balances move correctly for mixed normal-balance accounts; idempotency dedups; tenant-isolation rejects foreign accounts; reversal flips every line and restores balances.
- Convergence tests: a plain 2-account `createTransaction` now stores 2 `journalLines`; `recalculateAccountBalance` matches `journalDerivedBalance` for compound entries.
- Verifier tests: synthetic drift is detected; zero-drift books report balanced.
- Migration tests: dry-run writes nothing; backfill is idempotent (second run = no-op); post-migration drift = 0.
- Per-feature refactor: existing payroll/close/recognition suites stay green; add "posts a single balanced compound entry" assertions.
- Mock real models **without** `{ virtual: true }` (the established flake rule).
- After each phase: full suite green + (for posting-path phases) a live self-cleaning smoke on a real business, ending with `computeDrift` = 0.

## 10. Risk register

| Risk | Mitigation |
|---|---|
| Balance drift introduced by convergence | Verifier run after every phase; drift must read 0 before proceeding. |
| Historical migration corrupts real books | Dry-run + read-only drift report + explicit user go-ahead + replica-set transaction + idempotent + recomputable. Fenced as the last phase. |
| A hidden consumer relies on the exact 2-account shape | Projection fields are preserved; Phase 4 audits truth-readers explicitly. |
| Partial multi-doc write on a crash | All posting + balance writes share one `withTransaction` session (Atlas replica set). |
| Double balance update during convergence | One poster owns balance updates; `createTransaction` delegates rather than doing its own + the poster's. Covered by convergence tests + verifier. |

## 11. Out of scope

Immutable-by-construction JE storage (append-only event log), multi-currency per-line, and per-line tax attribution beyond what the tax engine already emits — all later, separate.

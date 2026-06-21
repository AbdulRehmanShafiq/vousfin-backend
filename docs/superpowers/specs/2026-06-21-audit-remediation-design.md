# Audit Remediation — Remaining Fixes (Design Spec)

**Date:** 2026-06-21
**Status:** Design approved (decisions locked via brainstorming). Next: writing-plans → subagent-driven execution.
**Source:** `docs/audit/2026-06-21-vousfin-codebase-audit.md` (findings A1–A14 + T1–T3).

## Already fixed & pushed (context — do NOT redo)
A1, A2, A4, A5(realised FX wired), A6, A3/A9 (reversal/CN-apply/VC-apply atomic), A7, A8,
bill-AP-swallow, invoice-AR-swallow, T1(doc), A10 (bill.markPaid + invoice.markPaid +
invoice.writeOff atomic), A11 (3-way-match zero-received). Backend HEAD `9ac3d07`.
Suite 168/1230 green; drift 0.

## Locked decisions (brainstorming)
- **A12:** Block bill approval on a BLOCKED match / duplicate invoice **unless an explicit override** is passed (recorded in audit + approval log). WARN-level variances stay advisory. Match-engine *errors* degrade to advisory (don't block on inability to run).
- **A13:** **Full GRNI accrual** (proper ERP treatment).
- **T3:** Fix all harmful swallows **and** annotate the best-effort ones with a one-line marker.
- **T2:** **Deferred deliberately** (caching a period-lock check is correctness-sensitive — a just-closed period could wrongly accept a write). Documented as a conscious non-fix.

## Execution: subagent-driven, model-switched
- **opus** — A13 GRNI posting design + the final whole-branch review.
- **sonnet** — Phase 1/2 logic.
- **haiku** — mechanical bits (COA entry, comment classification).
- TDD throughout; each phase ends green + drift 0 + committed.

---

## Phase 1 — Atomicity & swallow completion (bug fixes)

**1.1 `reverseTransaction` external session.**
`services/transaction.service.js` `reverseTransaction(txId, biz, { reversalDate, reason, session } = {}, userId, ip)`.
Replace `const reversal = await withTransaction(async (s) => {...})` with
`const runUnit = session ? (fn) => fn(session) : (fn) => withTransaction(fn); const reversal = await runUnit(async (s) => {...})`.
Existing A9 atomicity test (session undefined → withTransaction path) must still pass.

**1.2 `creditNote.cancel` atomic (A10 residual).**
`services/creditNote.service.js` `cancel()`: wrap the invoice update + `reverseTransaction(id, biz, { reason, session: s })` + `partyBalanceService.adjustReceivable({..., session: s })` + `cn.save({ session: s })` in one `withTransaction`. Remove the two swallowing try/catch blocks ([:280, :298]). Test: cancel rejects (does not swallow) when the reversal fails; mock `transaction.service.reverseTransaction` in the CN test harness.

**1.3 Invoice COGS swallow.**
`services/invoice.service.js` `_applyCogsForInvoice` failure is swallowed at `:838` → revenue recognised without COGS. Recognise COGS inside the AR-recognition transaction; stop swallowing. Order so the GL COGS post happens with AR (a COGS failure rolls back the recognition). Stock reduction (`reduceStock`) stays the subledger write; if COGS GL fails, the recognition rolls back and stock must not be left reduced — reduce stock only after the COGS GL leg is committed in the same unit, or restore on failure. (Detail the exact ordering in the plan.)

**1.4 `partyBalance` not-found swallows.**
`services/partyBalance.service.js` `:86`/`:123`: adjusting a non-existent customer/vendor currently warns + returns (balance silently not updated). Throw `ApiError(404)` so an enclosing transaction rolls back. Check callers tolerate a throw (they're inside txns now).

**1.5 T3 classify-all.**
Add a one-line `// best-effort: <why>` marker to the audit-log / cache-invalidation / event-emit / email catches (the ~30 benign ones) so the harmful-vs-benign distinction is explicit for future readers. No behavior change.

---

## Phase 2 — A12: 3-way match gating (block-unless-override)

`services/bill.service.js` `approve(id, user, note, ipAddress, { override = false } = {})`:
1. Run `billMatchingService.runFullMatch(...)` and READ its `status` (do not swallow the gating decision; engine errors → log + treat as non-blocking).
2. If `status === BLOCKED` OR `matchResult.duplicateCheck.isDuplicate`, and `!override`: throw `ApiError(409, 'Bill blocked by 3-way match: <summary>. Approve with override to proceed.')`.
3. If override: proceed AND push an `override` note to `bill.approvalLog` + `auditService.log` (who/why).
4. AP posting (`postApLiabilityJournal`) unchanged otherwise (still re-throws per the prior fix).

Controller/route: thread `override` from the request body (admin-gated) into `approve`. Validation accepts optional `override: boolean`. Frontend surfacing is an optional follow-up (note in plan, not required for backend correctness).

Tests: approve rejects 409 on BLOCKED without override; approve proceeds + logs when override true; WARN-level match still approves; engine error doesn't block.

---

## Phase 3 — A13: Full GRNI accrual

**3.1 COA.** Add to `config/constants.js` `DEFAULT_ACCOUNTS`:
`{ accountCode: '2115', accountName: 'Goods Received Not Invoiced', accountType: 'Liability', accountSubtype: 'Current Liabilities', normalBalance: 'Credit', isDefault: true }`.
Existing businesses backfilled by `accountRepository.syncMissingDefaults` (already called on `GET /business/accounts`). GRN/bill use a lazy `_ensureAccount('2115')` (mirror jobCosting's `_ensureAccount` for 1150) so it's present on demand even before a settings fetch.

**3.2 GRN confirm posts the accrual (also fixes A14).**
`services/goodsReceipt.service.js` on receive/confirm, for each stocked line (`inventoryItemId`):
post **DR Inventory (1150) / CR GRNI (2115)** at landed cost (qty × unit cost), as ONE compound `postCompoundJournal` for the GRN, **atomically** with `applyPurchaseStock` and the state change (one `withTransaction`, session threaded). Idempotent via a stored `grn.glJournalId` (skip if already posted). Stop swallowing stock-in (A14) — a failure rolls the whole receive back. Service/non-stock lines: no inventory posting.

**3.3 Bill approval clears GRNI (the split rule).**
`services/bill.service.js` `postApLiabilityJournal`: build a compound entry —
- **Received-stock portion** (sum of GRNI value for the bill's linked GRNs / stocked lines): **DR GRNI (2115)**.
- **Remainder** (non-stock lines, freight, services, and any received-stock not yet GRN'd): **DR Expense / Inventory** as today.
- **Tax** (if any): existing tax legs.
- **CR Accounts Payable (2110)** for the bill total.
Rule: `grniDebit = min(Σ linked-GRN stocked value, bill stocked-line subtotal)`; expense debit = bill subtotal − grniDebit; both + tax credit-balance to AP. Define precisely in the plan with worked examples (full match, partial receive, over-bill, no-GRN bill).

**3.4 Reversals.** GRN cancel reverses its DR Inventory/CR GRNI journal (via the canonical poster reversal) + reverses stock. Bill reverse already handled by `reverseTransaction` (which now sees the GRNI debit in journalLines and flips it).

Tests: GRN confirm posts DR Inv/CR GRNI + stock + idempotent; bill approval clears GRNI for received portion, expense for remainder, balances to AP; GRN cancel reverses; a stocked bill with no GRN debits expense (back-compat); drift stays 0 across the GRN→bill→pay lifecycle.

---

## Cross-cutting / acceptance
- No new dependencies. All postings via the canonical posters (`postCompoundJournal`/`postBalancedJournal`) — drift-neutral.
- Each phase: failing test → fix → green → `npm test` full suite green → `node scripts/ledgerDrift.js` = 0 → commit. Final whole-branch review on opus.
- Plain-language user-facing copy (errors/labels).

## Non-goals
- T2 period-query caching (deliberate — see locked decisions).
- Frontend surfacing of the A12 override (backend API supports it; UI is a follow-up).
- Per-line GRNI matching beyond the value-split rule in 3.3 (line-level GRNI reconciliation is a future enhancement).

# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining confirmed accounting-integrity defects from the 2026-06-21 audit — silent failures around money writes, advisory-only 3-way matching, and the missing Goods-Received-Not-Invoiced (GRNI) accrual.

**Architecture:** Three phases. Phase 1 finishes the atomicity/swallow sweep (every money-affecting write either commits in one unit or surfaces its failure). Phase 2 makes 3-way match BLOCK bill approval unless an explicit, logged override is passed. Phase 3 adds full GRNI accrual: the GRN posts DR Inventory / CR GRNI at receipt and the Bill clears DR GRNI / CR AP, so the GL inventory balance tracks the subledger from receipt to payment.

**Tech Stack:** Node.js, Express, Mongoose, Jest. All GL postings go through the canonical posters in `services/ledgerPosting.service.js` (`postBalancedJournal` / `postCompoundJournal`) — never raw `JournalEntry.create`.

## Global Constraints

- **TDD always.** Write the failing test, watch it fail for the right reason, write minimal code, watch it pass. No production code without a failing test first.
- **All GL postings go through `postBalancedJournal` / `postCompoundJournal`** — both are balanced-by-construction and update running balances, so the trial balance stays drift-neutral. Never call `JournalEntry.create` directly for a balance-affecting entry.
- **Idempotency on every system posting.** Use `metadata.idempotencyKey` (or an existing `*JournalId` guard) so a retry after a partial failure can never double-post.
- **Never swallow a money write.** A `catch` around a GL post, a balance adjustment, or a subledger mutation that affects reported figures must re-throw (after restoring in-memory mutations) — not `logger.warn` and continue. Best-effort catches (audit log, cache invalidation, event emit, reorder email) stay, but get a one-line `// best-effort: <why>` marker.
- **Plain-language user-facing copy.** Error messages a business owner might see avoid accounting/FBR jargon as the primary text (e.g. "Bill blocked: goods not received" before any "3-way match" phrasing).
- **Run the full suite + drift after every task:** `npm test` must stay green and `node scripts/ledgerDrift.js` must read 0 before committing.
- **Test layout:** unit tests live under `tests/unit/services/`; integration under `tests/integration/`. The `__tests__/` directory is ignored by Jest — do not put tests there.
- **Money rounding:** use the local `r2`/`round2` 2-decimal helper already present in each service; never compare floats with `===` without snapping sub-cent residue.

---

## Phase 1 — Atomicity & swallow completion

### Task 1: `reverseTransaction` accepts an external session

**Files:**
- Modify: `services/transaction.service.js:1244-1382` (`reverseTransaction`)
- Test: `tests/unit/services/transaction.reversal.atomicity.test.js` (existing — add one case)

**Interfaces:**
- Consumes: `withTransaction(fn)` from `utils/withTransaction`.
- Produces: `reverseTransaction(transactionId, businessId, { reversalDate, reason, session } = {}, userId, ipAddress)` — when `session` is supplied, all reversal writes join that session instead of opening a new transaction. Task 2 (creditNote.cancel) consumes this.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/services/transaction.reversal.atomicity.test.js`:

```js
test('reverseTransaction joins a caller-supplied session instead of opening its own', async () => {
  // withTransaction must NOT be called when an external session is passed.
  const withTx = require('../../../utils/withTransaction');
  const spy = jest.spyOn(withTx, 'withTransaction');
  const fakeSession = { id: 'caller-session' };

  // Arrange an original transaction the repo will return (reuse this file's existing
  // buildOriginal helper / mock setup used by the other tests in this suite).
  const original = buildOriginal({ status: 'posted', partiallyPaidAmount: 0, journalLines: [] });
  transactionRepository.findByIdWithDetails.mockResolvedValue(original);
  transactionRepository.createTransaction.mockResolvedValue({ _id: 'rev1', debitAccountId: 'd', creditAccountId: 'c' });
  transactionRepository.updateTransaction.mockResolvedValue({});

  await service.reverseTransaction(
    original._id, original.businessId,
    { reason: 'test', session: fakeSession },
    'user1', '0.0.0.0'
  );

  expect(spy).not.toHaveBeenCalled();
  // The reversal entry was created on the caller's session.
  expect(transactionRepository.createTransaction).toHaveBeenCalledWith(expect.any(Object), fakeSession);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- transaction.reversal.atomicity`
Expected: FAIL — `withTransaction` IS called (current code always opens its own transaction).

- [ ] **Step 3: Write minimal implementation**

In `services/transaction.service.js`, change the signature and the transaction wrapper.

Signature (line 1244):
```js
  async reverseTransaction(transactionId, businessId, { reversalDate, reason, session } = {}, userId, ipAddress) {
```

Replace the wrapper at line 1315 (`const reversal = await withTransaction(async (s) => {`) so it reuses an injected session:
```js
    // Join the caller's transaction when one is supplied (so an enclosing unit —
    // e.g. creditNote.cancel — commits the reversal together with its own writes),
    // otherwise open our own all-or-nothing transaction (legacy standalone path).
    const runUnit = session
      ? (fn) => fn(session)
      : (fn) => withTransaction(fn);
    const reversal = await runUnit(async (s) => {
```

(The body from line 1316 to the closing `});` at 1350 is unchanged — it already uses `s` throughout.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- transaction.reversal.atomicity`
Expected: PASS. The pre-existing "no external session → withTransaction path" test in this file must also still pass.

- [ ] **Step 5: Commit**

```bash
git add services/transaction.service.js tests/unit/services/transaction.reversal.atomicity.test.js
git commit -m "feat(reversal): reverseTransaction accepts an external session (audit Phase 1.1)"
```

---

### Task 2: `creditNote.cancel` is atomic and stops swallowing

**Files:**
- Modify: `services/creditNote.service.js:248-309` (`cancel`)
- Test: `tests/unit/services/creditNote.service.test.js` (existing)

**Interfaces:**
- Consumes: `reverseTransaction(..., { reason, session }, ...)` from Task 1; `partyBalanceService.adjustReceivable(businessId, customerId, delta, { ..., session })`; `withTransaction`.
- Produces: `cancel(id, user, reason, ipAddress)` now rejects (does not swallow) when the GL reversal or balance restore fails.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/services/creditNote.service.test.js`:

```js
test('cancel rejects (does not swallow) when the GL reversal fails', async () => {
  const cn = buildCreditNote({ state: 'applied', noteType: 'credit_note', linkedJournalEntryId: 'je1', totalAmount: 500 });
  service._loadOrThrow = jest.fn().mockResolvedValue(cn);
  Invoice.findById.mockResolvedValue(buildInvoice({ customerId: 'cust1', remainingBalance: 0, totalCredited: 500 }));

  const transactionService = require('../../../services/transaction.service');
  jest.spyOn(transactionService, 'reverseTransaction').mockRejectedValue(new Error('GL down'));

  await expect(service.cancel(cn._id, { _id: 'u1', businessId: 'b1' }, 'mistake', '0.0.0.0'))
    .rejects.toThrow('GL down');

  // The credit note must NOT have been flipped to cancelled when the reversal failed.
  expect(cn.state).not.toBe('cancelled');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- creditNote.service`
Expected: FAIL — current `cancel` swallows the reversal error and still sets `cn.state = 'cancelled'`.

- [ ] **Step 3: Write minimal implementation**

Replace the body of `cancel` from line 252 (`if (cn.state === 'applied') {`) through line 307 (`await cn.save();`) with a single atomic unit. Require `withTransaction` at the top of the file if not already imported (`const { withTransaction } = require('../utils/withTransaction');`).

```js
    // Cancel must be all-or-nothing: the invoice rollback, the GL reversal, the
    // receivable restore and the state flip commit together or not at all. The
    // previous version swallowed the reversal + balance errors, leaving a credit
    // note CANCELLED while its GL effect and the customer balance were untouched
    // (audit Phase 1.2 — A10 residual).
    await withTransaction(async (s) => {
      if (cn.state === 'applied') {
        const invoice = await Invoice.findById(cn.invoiceId).session(s);
        if (invoice) {
          if (cn.noteType === 'credit_note') {
            invoice.totalCredited = Math.max(0, (invoice.totalCredited || 0) - cn.totalAmount);
            invoice.remainingBalance = (invoice.remainingBalance || 0) + cn.totalAmount;
            invoice.creditNoteIds = (invoice.creditNoteIds || []).filter(
              cid => String(cid) !== String(cn._id)
            );
          } else {
            invoice.remainingBalance = Math.max(0, (invoice.remainingBalance || 0) - cn.totalAmount);
          }
          invoice.lastModifiedBy = user._id;
          await invoice.save({ session: s });

          if (cn.linkedJournalEntryId) {
            const transactionService = require('./transaction.service');
            await transactionService.reverseTransaction(
              cn.linkedJournalEntryId.toString(),
              cn.businessId.toString(),
              { reason: `Credit note ${cn.creditNoteNumber} cancelled`, session: s },
              user._id,
              ipAddress
            );

            if (cn.noteType === 'credit_note' && invoice.customerId) {
              await partyBalanceService.adjustReceivable(
                cn.businessId, invoice.customerId, cn.totalAmount,
                { userId: user._id, reason: 'credit_note_cancelled', entityType: 'creditNote', entityId: cn._id, session: s }
              );
            }
          }
        }
      }

      cn.state = 'cancelled';
      cn.lastModifiedBy = user._id;
      await cn.save({ session: s });
    });
    return cn;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- creditNote.service`
Expected: PASS. The existing "apply is atomic" test must still pass.

- [ ] **Step 5: Commit**

```bash
git add services/creditNote.service.js tests/unit/services/creditNote.service.test.js
git commit -m "fix(creditNote): cancel atomic + surfaces reversal/balance failures (audit Phase 1.2)"
```

---

### Task 3: Invoice COGS recognized atomically with revenue (stop swallowing)

**Files:**
- Modify: `models/InventoryItem.model.js:146-153` (`reduceStock` method — accept session)
- Modify: `services/inventory.service.js:237` (`reduceStock` — accept + thread session)
- Modify: `services/invoice.service.js:757-841` (move COGS inside the AR transaction)
- Test: `tests/unit/services/invoice.service.test.js` (existing)

**Interfaces:**
- Consumes: `postBalancedJournal(payload, { session })`; `inventoryService.reduceStock(businessId, itemId, qty, session)`; `inventoryService.resolveCostAccounts(businessId)`.
- Produces: `_applyCogsForInvoice(invoice, user, session = null)` posts the COGS journal on the given session; `postArJournal` now recognizes COGS inside the same `withTransaction` as the AR debit, so an invoice can never be reported approved with revenue but no COGS.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/services/invoice.service.test.js`:

```js
test('postArJournal rolls back AR when COGS posting fails (no revenue without COGS)', async () => {
  const invoice = buildInvoice({
    invoiceNumber: 'INV-COGS-1',
    lineItems: [{ inventoryItemId: 'item1', quantity: 2, accountId: 'rev1' }],
    amount: 1000, totalAmount: 1000, taxAmount: 0,
  });
  // AR account + revenue resolvable
  ChartOfAccount.findOne.mockResolvedValue({ _id: 'ar1' });
  // reduceStock succeeds, but the COGS GL post throws
  const inventoryService = require('../../../services/inventory.service');
  jest.spyOn(inventoryService, 'reduceStock').mockResolvedValue({ cogsAmount: 600 });
  jest.spyOn(inventoryService, 'resolveCostAccounts').mockResolvedValue({ cogsAccountId: 'cogs1', inventoryAccountId: 'inv1' });
  postBalancedJournal
    .mockResolvedValueOnce({ _id: 'arJe' })        // AR debit succeeds
    .mockRejectedValueOnce(new Error('COGS post failed')); // COGS leg fails

  await expect(service.postArJournal(invoice, { _id: 'u1' }, '0.0.0.0'))
    .rejects.toThrow('COGS post failed');

  // AR link must be cleared (rolled back) so a retry re-posts cleanly.
  expect(invoice.arJournalId).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- invoice.service`
Expected: FAIL — current code posts COGS in a swallowing try/catch AFTER the AR transaction closes, so AR is committed and the COGS error is swallowed (no throw).

- [ ] **Step 3: Write minimal implementation**

**3a — model** (`models/InventoryItem.model.js:146`):
```js
inventoryItemSchema.methods.reduceStock = async function (qty, session = null) {
  if (qty <= 0) throw new Error('Quantity must be positive');
  if (qty > this.currentStock) throw new Error(`Insufficient stock: ${this.currentStock} available`);
  const cogs = qty * this.unitCostPrice;
  this.currentStock -= qty;
  await this.save({ session });
  return { cogsAmount: Math.round(cogs * 100) / 100, unitCostUsed: this.unitCostPrice };
};
```

**3b — inventory service** (`services/inventory.service.js:237`):
```js
  async reduceStock(businessId, itemId, qty, session = null) {
    const item = await inventoryItemRepository.model.findOne({ _id: itemId, businessId }).session(session);
    if (!item) throw new ApiError(404, 'Inventory item not found');
    const stockBefore = item.currentStock;
    const valuationBefore = Math.round(stockBefore * item.unitCostPrice * 100) / 100;
    const { cogsAmount, unitCostUsed } = await item.reduceStock(qty, session);
```
(The rest of `reduceStock` — logging, event emits, reorder trigger — is unchanged; those are best-effort and stay outside the session.)

**3c — invoice service** (`services/invoice.service.js`): move the COGS call INSIDE the AR `withTransaction`, threading the session, and DELETE the swallowing block at 832-839.

Inside the `withTransaction(async (session) => { ... })` block, after the customer balance adjustment (current line 818, just before the block closes at 819), add:
```js
        // Matching principle — recognize COGS in the SAME unit as the revenue.
        // A COGS/stock failure now rolls back the AR recognition (audit Phase 1.3),
        // instead of leaving revenue posted with COGS silently skipped.
        await this._applyCogsForInvoice(invoice, user, session);
```

Delete lines 832-839 (the `// ── ERP Step 5 ...` comment block and its swallowing `try { await this._applyCogsForInvoice(invoice, user); } catch (e) { logger.warn(...) }`).

Update `_applyCogsForInvoice` signature (line 858) and thread the session into both `reduceStock` and `postBalancedJournal`:
```js
  async _applyCogsForInvoice(invoice, user, session = null) {
```
Line 870 call:
```js
        const { cogsAmount } = await inventoryService.reduceStock(
          invoice.businessId, li.inventoryItemId, Number(li.quantity), session
        );
```
The per-line `try/catch` that swallows a stock-reduction failure (lines 869-876) must RE-THROW so a failed reduction rolls back the unit. Replace it with a direct call (no catch):
```js
      const { cogsAmount } = await inventoryService.reduceStock(
        invoice.businessId, li.inventoryItemId, Number(li.quantity), session
      );
      totalCogs = r2(totalCogs + (cogsAmount || 0));
```
The final `postBalancedJournal({...})` at line 886 gets the session as its second arg:
```js
    await postBalancedJournal({
      // ...existing payload unchanged...
    }, { session });
```
Keep the existing "COGS/Inventory account not found" guard returning `totalCogs` (a business with no inventory accounts configured simply skips the GL leg — not an error path).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- invoice.service`
Expected: PASS. Existing invoice tests (markPaid/writeOff atomicity, approve happy-path) still pass.

- [ ] **Step 5: Commit**

```bash
git add models/InventoryItem.model.js services/inventory.service.js services/invoice.service.js tests/unit/services/invoice.service.test.js
git commit -m "fix(invoice): recognize COGS atomically with revenue, stop swallowing (audit Phase 1.3)"
```

---

### Task 4: `partyBalance` not-found throws instead of warning

**Files:**
- Modify: `services/partyBalance.service.js:82-88` (`adjustReceivable`) and `:121-125` (`adjustPayable`)
- Test: `tests/unit/services/partyBalance.service.test.js` (create if absent)

**Interfaces:**
- Produces: `adjustReceivable` / `adjustPayable` throw `ApiError(404)` when the party row is gone at write time, so an enclosing transaction rolls back rather than silently skipping a balance update. The `delta === 0` / null-id no-op short-circuit at the top is preserved (those are legitimate no-ops, not failures).

- [ ] **Step 1: Write the failing test**

Create/append `tests/unit/services/partyBalance.service.test.js`:

```js
const service = require('../../../services/partyBalance.service');
const customerRepository = require('../../../repositories/customer.repository');
const vendorRepository = require('../../../repositories/vendor.repository');
jest.mock('../../../repositories/customer.repository');
jest.mock('../../../repositories/vendor.repository');

test('adjustReceivable throws when the customer is gone at write time', async () => {
  customerRepository.updateReceivableBalance.mockResolvedValue(null);
  await expect(service.adjustReceivable('b1', 'cust1', 250, { reason: 'invoice_approved' }))
    .rejects.toThrow(/customer/i);
});

test('adjustPayable throws when the vendor is gone at write time', async () => {
  vendorRepository.updatePayableBalance.mockResolvedValue(null);
  await expect(service.adjustPayable('b1', 'vend1', 250, { reason: 'bill_approved' }))
    .rejects.toThrow(/vendor/i);
});

test('adjustReceivable is still a no-op for a zero delta', async () => {
  const r = await service.adjustReceivable('b1', 'cust1', 0, {});
  expect(r).toBeNull();
  expect(customerRepository.updateReceivableBalance).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- partyBalance.service`
Expected: FAIL — current code `logger.warn` + `return null` instead of throwing.

- [ ] **Step 3: Write minimal implementation**

`adjustReceivable` (replace lines 83-88):
```js
    const updated = await customerRepository.updateReceivableBalance(id, amount, ctx.session || null);
    if (!updated) {
      // The party was deleted between the ledger write and this balance update.
      // Throw so the enclosing transaction rolls back — a posted AR move with no
      // matching customer balance is a real divergence, not something to swallow
      // (audit Phase 1.4).
      throw new ApiError(404, `Cannot update receivable: customer ${id} not found.`);
    }
```

`adjustPayable` (replace lines 122-125):
```js
    const updated = await vendorRepository.updatePayableBalance(id, amount, ctx.session || null);
    if (!updated) {
      throw new ApiError(404, `Cannot update payable: vendor ${id} not found.`);
    }
```

Ensure `ApiError` is imported at the top of the file (`const { ApiError } = require('../utils/ApiError');`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- partyBalance.service`
Expected: PASS. Then run the full suite — `npm test` — and fix any caller test that depended on the silent no-op (callers now inside transactions tolerate the throw; a unit test that asserted a no-op on a missing party should assert the throw instead).

- [ ] **Step 5: Commit**

```bash
git add services/partyBalance.service.js tests/unit/services/partyBalance.service.test.js
git commit -m "fix(partyBalance): throw on missing party so enclosing txn rolls back (audit Phase 1.5)"
```

---

### Task 5: T3 — annotate the best-effort catches (mechanical, no behavior change)

**Files:**
- Modify (comments only): the benign `catch` blocks across the service layer that intentionally swallow non-money side effects (audit-log writes, cache invalidation, event emits, reorder/notification emails, installment-plan cascade). Confirmed examples to annotate: `services/transaction.service.js:1362-1365` (installment cascade), `services/inventory.service.js` event emits, `services/goodsReceipt.service.js:260-262` (PO quantity sync), and the audit-log/cache catches the implementer finds via the search below.

**This is a documentation-only task. No test. No logic change.** A reviewer's gate here is "every annotated catch is genuinely best-effort (no money/GL/balance/subledger write inside it) and no behavior changed."

- [ ] **Step 1: Find the candidate catches**

Run: `git grep -n "catch (" services/ | wc -l` to size the surface, then read each. For each `catch` block, classify:
- **Money/GL/balance/subledger write inside** → NOT this task (those were fixed in Phase 1 / earlier passes; if a new one is found, STOP and report it — it is a real bug, not a comment target).
- **Best-effort side effect** (logger only, then continue) → add a one-line marker.

- [ ] **Step 2: Annotate each benign catch**

Add exactly one comment line immediately inside the `catch`, stating why swallowing is safe. Example:
```js
    } catch (e) {
      // best-effort: PO quantity sync is a convenience mirror; the GRN + GL are the
      // source of truth, so a sync hiccup must not block confirming the receipt.
      logger.warn(`[grn] failed to update PO quantities: ${e.message}`);
    }
```
Do not change any executable line.

- [ ] **Step 3: Verify nothing changed behaviorally**

Run: `npm test`
Expected: PASS, identical count to before this task (comments don't change behavior). Run `node scripts/ledgerDrift.js` → 0.

- [ ] **Step 4: Commit**

```bash
git add services/
git commit -m "docs(swallows): annotate best-effort catches; harmful ones already fixed (audit Phase 1.6/T3)"
```

---

## Phase 2 — A12: 3-way match gating (block-unless-override)

### Task 6: `bill.approve` blocks on BLOCKED/duplicate unless overridden

**Files:**
- Modify: `services/bill.service.js:247-299` (`approve`)
- Test: `tests/unit/services/bill.service.test.js` (existing)

**Interfaces:**
- Consumes: `billMatchingService.runFullMatch(id, businessId)` → `{ status, matchResult, bill }` where `status` is a `THREE_WAY_MATCH_STATUSES` value (`'blocked'` is the block trigger) and `matchResult.duplicateCheck.isDuplicate` / `matchResult.summary` are present.
- Produces: `approve(id, user, note, ipAddress, { override = false } = {})`. Throws `ApiError(409)` on a blocked/duplicate match unless `override` is true; on override it records the override in `approvalLog` + audit and proceeds.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/services/bill.service.test.js`:

```js
const { THREE_WAY_MATCH_STATUSES: TWM } = require('../../../config/constants');

test('approve throws 409 when 3-way match is BLOCKED and no override', async () => {
  const bill = buildBill({ state: 'awaiting_approval', billNumber: 'BILL-1' });
  service._loadOrThrow = jest.fn().mockResolvedValue(bill);
  service._applyStateChange = jest.fn().mockResolvedValue(bill);
  jest.spyOn(billMatchingService, 'runFullMatch').mockResolvedValue({
    status: TWM.BLOCKED,
    matchResult: { duplicateCheck: { isDuplicate: false }, summary: 'GRN: under_received' },
    bill,
  });
  const postSpy = jest.spyOn(service, 'postApLiabilityJournal');

  await expect(service.approve(bill._id, { _id: 'u1', businessId: 'b1' }, 'ok', '0.0.0.0'))
    .rejects.toThrow(/blocked/i);
  // AP must NOT be posted for a blocked bill.
  expect(postSpy).not.toHaveBeenCalled();
});

test('approve proceeds and logs an override when override=true on a BLOCKED match', async () => {
  const bill = buildBill({ state: 'awaiting_approval', billNumber: 'BILL-2', approvalLog: [] });
  service._loadOrThrow = jest.fn().mockResolvedValue(bill);
  service._applyStateChange = jest.fn().mockResolvedValue(bill);
  jest.spyOn(billMatchingService, 'runFullMatch').mockResolvedValue({
    status: TWM.BLOCKED,
    matchResult: { duplicateCheck: { isDuplicate: false }, summary: 'GRN: under_received' },
    bill,
  });
  jest.spyOn(service, 'postApLiabilityJournal').mockResolvedValue({ _id: 'je1' });

  await service.approve(bill._id, { _id: 'u1', businessId: 'b1' }, 'override it', '0.0.0.0', { override: true });

  expect(service.postApLiabilityJournal).toHaveBeenCalled();
  expect(bill.approvalLog.some(l => l.action === 'override')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- bill.service`
Expected: FAIL — current `approve` runs match in a swallowing try/catch and never blocks; signature has no `override`.

- [ ] **Step 3: Write minimal implementation**

Change the signature (line 247):
```js
  async approve(id, user, note, ipAddress, { override = false } = {}) {
```

Replace the match block (lines 275-285) with gating that reads the result and decides before posting AP:
```js
    // Phase 3.2 — auto-run 3-way match, then GATE on it (audit A12). A BLOCKED
    // match or a duplicate vendor invoice stops approval unless the caller passes
    // an explicit override (admin decision, recorded below). Match-ENGINE errors
    // (e.g. the PO can't be loaded) degrade to advisory — we never block on an
    // inability to run the check, only on a check that ran and said "blocked".
    let matchOutcome = null;
    try {
      matchOutcome = await billMatchingService.runFullMatch(id, bill.businessId.toString());
    } catch (e) {
      // best-effort: a match-engine failure must not block a bill that may be fine.
      logger.warn(`[bill] 3-way match could not run on approval for ${bill.billNumber}: ${e.message}`);
    }

    if (matchOutcome) {
      const isBlocked = matchOutcome.status === THREE_WAY_MATCH_STATUSES.BLOCKED;
      const isDuplicate = !!matchOutcome.matchResult?.duplicateCheck?.isDuplicate;
      if ((isBlocked || isDuplicate) && !override) {
        const why = matchOutcome.matchResult?.summary || 'goods/PO mismatch';
        throw new ApiError(409, `Bill cannot be approved — it failed the goods/PO check (${why}). Approve with override to proceed anyway.`);
      }
      if ((isBlocked || isDuplicate) && override) {
        bill.approvalLog.push({
          action: 'override',
          actorId: user._id,
          actorName: user.fullName || user.email || 'Unknown',
          actorRole: user.role || null,
          note: `Override of ${matchOutcome.status}: ${matchOutcome.matchResult?.summary || ''}`.trim(),
          timestamp: new Date(),
        });
        await bill.save();
        await auditService.log({
          businessId: bill.businessId, userId: user._id,
          action: 'bill.match_override', entityType: ENTITY_TYPES.BILL, entityId: bill._id,
          metadata: { status: matchOutcome.status, summary: matchOutcome.matchResult?.summary || null },
          ipAddress,
        });
      }
    }

    // Post the AP liability journal. Do NOT swallow a failure here — the GL must
    // reflect the liability the moment a bill is approved.
    await this.postApLiabilityJournal(approved, user, ipAddress);
```

Confirm `THREE_WAY_MATCH_STATUSES`, `ENTITY_TYPES`, `ApiError`, `auditService`, and `logger` are imported in this file (they are used elsewhere in it; add any missing). Use the project's actual `auditService.log` shape — match the call signature already used elsewhere in `bill.service.js` (read one existing `auditService` call in the file and mirror it exactly; the example above is illustrative).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- bill.service`
Expected: PASS. Existing approve happy-path tests (non-blocked match) must still pass — a `MATCHED`/`PARTIAL_MATCH`/warn-level status does not block.

- [ ] **Step 5: Commit**

```bash
git add services/bill.service.js tests/unit/services/bill.service.test.js
git commit -m "feat(bill): block approval on failed 3-way match unless override (audit A12)"
```

---

### Task 7: Thread `override` through the bill-approval controller/route

**Files:**
- Modify: `controllers/bill.controller.js` (the `approve` handler)
- Modify: `routes/bill.routes.js` or the validator that guards the approve route (whichever validates the approve body)
- Test: `tests/integration/bill.routes.test.js` if one exists, else add a controller unit test under `tests/unit/controllers/`

**Interfaces:**
- Consumes: `billService.approve(id, user, note, ipAddress, { override })` from Task 6.
- Produces: `POST /bills/:id/approve` accepts an optional `override: boolean` in the body and forwards it.

- [ ] **Step 1: Read the current handler**

Run: `git grep -n "approve" controllers/bill.controller.js routes/bill.routes.js`
Read the `approve` controller to learn how `note`/`ipAddress` are currently extracted.

- [ ] **Step 2: Write the failing test**

Add a test asserting the controller forwards `req.body.override` into `billService.approve`'s 5th argument. Mirror the existing controller-test harness in the repo. Illustrative:
```js
test('approve controller forwards override flag', async () => {
  const approve = jest.spyOn(billService, 'approve').mockResolvedValue({ _id: 'b1' });
  const req = { params: { id: 'b1' }, body: { note: 'ok', override: true }, user: { _id: 'u1', businessId: 'biz' }, ip: '0.0.0.0' };
  const res = mockRes();
  await billController.approve(req, res, jest.fn());
  expect(approve).toHaveBeenCalledWith('b1', req.user, 'ok', '0.0.0.0', { override: true });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- bill.controller` (or the integration test path)
Expected: FAIL — the controller currently calls `approve` with 4 args.

- [ ] **Step 4: Write minimal implementation**

In the controller `approve` handler, extract and forward override:
```js
    const { note, override } = req.body || {};
    const bill = await billService.approve(req.params.id, req.user, note, req.ip, { override: !!override });
```
If the approve route has a request-body validator (Joi/express-validator), add `override` as an optional boolean so it isn't stripped. Keep it admin-gated: if the route already applies a role middleware for approval, `override` rides on the same authorization — no separate gate needed. (If approval is NOT role-gated today, note that in the final review rather than adding scope here.)

- [ ] **Step 5: Run test to verify it passes + commit**

Run: `npm test`
Expected: PASS; drift 0.
```bash
git add controllers/bill.controller.js routes/bill.routes.js tests/
git commit -m "feat(bill): accept override flag on approve route (audit A12 wiring)"
```

---

## Phase 3 — A13: Full GRNI accrual

### Task 8: Add the GRNI account (2115) + lazy ensure helper

**Files:**
- Modify: `config/constants.js:162` area (insert into `DEFAULT_ACCOUNTS` after 2110)
- Test: `tests/unit/config/constants.test.js` (create if absent) — assert the account exists and codes are unique

**Interfaces:**
- Produces: `DEFAULT_ACCOUNTS` contains `{ accountCode: '2115', accountName: 'Goods Received Not Invoiced', accountType: 'Liability', accountSubtype: 'Current Liabilities', normalBalance: 'Credit', isDefault: true }`. Existing businesses backfill via `accountRepository.syncMissingDefaults` (already called on `GET /business/accounts`). Tasks 9 & 10 resolve it lazily with `_ensureAccount(businessId, '2115')`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/config/constants.test.js`:
```js
const { DEFAULT_ACCOUNTS } = require('../../../config/constants');

test('GRNI account 2115 is a default', () => {
  const grni = DEFAULT_ACCOUNTS.find(a => a.accountCode === '2115');
  expect(grni).toBeDefined();
  expect(grni).toMatchObject({
    accountName: 'Goods Received Not Invoiced',
    accountType: 'Liability', normalBalance: 'Credit', isDefault: true,
  });
});

test('all default account codes are unique', () => {
  const codes = DEFAULT_ACCOUNTS.map(a => a.accountCode);
  expect(new Set(codes).size).toBe(codes.length);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- constants`
Expected: FAIL — 2115 does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Insert one line into `DEFAULT_ACCOUNTS` immediately after the `2110` Accounts Payable entry (line 162):
```js
    { accountCode: '2115', accountName: 'Goods Received Not Invoiced',  accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
```

- [ ] **Step 4: Run test to verify it passes + commit**

Run: `npm test -- constants`
Expected: PASS.
```bash
git add config/constants.js tests/unit/config/constants.test.js
git commit -m "feat(coa): add Goods Received Not Invoiced (2115) default account (audit A13)"
```

---

### Task 9: GRN confirm posts DR Inventory / CR GRNI atomically (fixes A13 + A14)

**Files:**
- Modify: `models/InventoryItem.model.js:133-141` (`addStock` — accept session)
- Modify: `services/inventory.service.js:195-226` (`applyPurchaseStock` — thread `opts.session`)
- Modify: `services/goodsReceipt.service.js:221-329` (`confirm` + `_applyReceivedStock`)
- Test: `tests/unit/services/goodsReceipt.service.test.js` (create if absent)

**Interfaces:**
- Consumes: `_ensureAccount(businessId, code)` (copy the helper from `services/jobCosting.service.js:15-22`); `postCompoundJournal(payload, { session })`; `applyPurchaseStock(businessId, itemId, qty, costPerUnit, { userId, vendorId, session })`.
- Produces: on confirm, a GRN with stocked lines posts ONE compound entry — DR Inventory (1150) / CR GRNI (2115) at Σ(acceptedQty × unitCost) — idempotent via `metadata.idempotencyKey = 'grn:accrual:<grnId>'` and a stored `grn.glJournalId`. Stock-in and the GL post no longer swallow failures.

**Design note (read before implementing):** `applyPurchaseStock` / `addStock` are made session-aware so the GL post + subledger increment + state change run in ONE `withTransaction`. The event emits inside `applyPurchaseStock` stay best-effort (outside the session). Idempotency is belt-and-suspenders: `grn.inventoryApplied` guards the subledger, the `idempotencyKey` guards the GL — so even a retry after a crash converges. Service/non-stock lines (no `inventoryItemId`) post no inventory leg; their cost is accrued later when the Bill posts (Task 10 remainder).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/services/goodsReceipt.service.test.js`:
```js
test('confirm posts DR Inventory / CR GRNI for stocked lines and is idempotent', async () => {
  const grn = buildGrn({
    state: 'draft', grnNumber: 'GRN-1', inventoryApplied: false, glJournalId: null,
    receivedItems: [{ inventoryItemId: 'item1', quantityReceived: 10, quantityRejected: 0, unitCost: 50, name: 'Widget' }],
  });
  service._loadOrThrow = jest.fn().mockResolvedValue(grn);
  service._applyStateChange = jest.fn().mockResolvedValue(grn);
  service._ensureAccount = jest.fn()
    .mockImplementation((b, code) => Promise.resolve({ _id: code === '1150' ? 'inv1' : 'grni1', accountCode: code }));
  const inventoryService = require('../../../services/inventory.service');
  jest.spyOn(inventoryService, 'applyPurchaseStock').mockResolvedValue({ item: {} });

  await service.confirm(grn._id, { _id: 'u1', businessId: 'b1' }, '0.0.0.0');

  // One compound GL entry: DR 1150 500 / CR 2115 500.
  expect(postCompoundJournal).toHaveBeenCalledWith(
    expect.objectContaining({
      idempotencyKey: `grn:accrual:${grn._id}`,
      lines: expect.arrayContaining([
        expect.objectContaining({ accountId: 'inv1', type: 'debit', amount: 500 }),
        expect.objectContaining({ accountId: 'grni1', type: 'credit', amount: 500 }),
      ]),
    }),
    expect.objectContaining({ session: expect.anything() }),
  );
});

test('confirm re-throws when the inventory accrual fails (no silent stock-in)', async () => {
  const grn = buildGrn({ state: 'draft', grnNumber: 'GRN-2', inventoryApplied: false,
    receivedItems: [{ inventoryItemId: 'item1', quantityReceived: 5, quantityRejected: 0, unitCost: 20, name: 'X' }] });
  service._loadOrThrow = jest.fn().mockResolvedValue(grn);
  service._ensureAccount = jest.fn().mockResolvedValue({ _id: 'inv1' });
  postCompoundJournal.mockRejectedValue(new Error('GL down'));
  await expect(service.confirm(grn._id, { _id: 'u1', businessId: 'b1' }, '0.0.0.0')).rejects.toThrow('GL down');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- goodsReceipt.service`
Expected: FAIL — `confirm` posts no GL entry today and swallows stock-in.

- [ ] **Step 3: Write minimal implementation**

**9a — model** (`models/InventoryItem.model.js:133`):
```js
inventoryItemSchema.methods.addStock = async function (qty, costPerUnit, session = null) {
  if (qty <= 0) throw new Error('Quantity must be positive');
  const totalValue = this.currentStock * this.unitCostPrice + qty * costPerUnit;
  const newQty = this.currentStock + qty;
  this.unitCostPrice = newQty > 0 ? totalValue / newQty : costPerUnit;
  this.currentStock = newQty;
  await this.save({ session });
  return this;
};
```

**9b — inventory service** (`services/inventory.service.js:195`): thread `opts.session`:
```js
  async applyPurchaseStock(businessId, itemId, qty, costPerUnit, opts = {}) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');
    if (!(Number(qty) > 0)) throw new ApiError(400, 'Quantity must be a positive number');
    const item = await inventoryItemRepository.model.findOne({ _id: itemId, businessId }).session(opts.session || null);
    if (!item) throw new ApiError(404, 'Inventory item not found');
    const valuationBefore = Math.round(item.currentStock * item.unitCostPrice * 100) / 100;
    const cost = Number(costPerUnit) > 0 ? Number(costPerUnit) : item.unitCostPrice;
    await item.addStock(qty, cost, opts.session || null);
```
(The rest — logging + the two best-effort event emits — is unchanged.)

**9c — goodsReceipt service**: add the `_ensureAccount` helper (copy from jobCosting), import `postCompoundJournal` and `withTransaction`, and rewrite `confirm`'s receive section + `_applyReceivedStock` to post the accrual atomically.

At the top of `services/goodsReceipt.service.js` add:
```js
const { postCompoundJournal } = require('./ledgerPosting.service');
const { withTransaction } = require('../utils/withTransaction');
const accountRepo = require('../repositories/account.repository');

async function _ensureAccount(businessId, code) {
  let acc = await accountRepo.findByCode(businessId, code);
  if (!acc) {
    if (typeof accountRepo.syncMissingDefaults === 'function') await accountRepo.syncMissingDefaults(businessId);
    acc = await accountRepo.findByCode(businessId, code);
  }
  return acc;
}
```
(Expose `_ensureAccount` as a method on the service class so tests can stub it: add `_ensureAccount(businessId, code) { return _ensureAccount(businessId, code); }` to the class.)

Replace the swallowing block in `confirm` (lines 264-272) with a non-swallowing call:
```js
    // ── ERP Step 5 + A13: receive goods into inventory AND post the GRNI accrual,
    // atomically. A failure now rolls the receive back (was silently swallowed —
    // A14). Idempotent, so a retry after a crash converges.
    await this._applyReceivedStock(grn, user);
```

Rewrite `_applyReceivedStock` (lines 295-329) to compute the inventory value, post the compound GL entry, increment the subledger, and persist the guard — all in one transaction:
```js
  async _applyReceivedStock(grn, user) {
    if (grn.inventoryApplied && grn.glJournalId) {
      logger.debug(`[grn] stock + accrual already applied for ${grn.grnNumber} — skipping`);
      return;
    }

    // Gather stocked lines and their landed value.
    const stockedLines = [];
    let inventoryValue = 0;
    for (const ri of (grn.receivedItems || [])) {
      if (!ri.inventoryItemId) continue; // service / untracked — accrued at Bill, no inventory leg
      const acceptedQty = Math.max(0, Number(ri.quantityReceived || 0) - Number(ri.quantityRejected || 0));
      if (acceptedQty <= 0) continue;
      const unitCost = Number(ri.unitCost) || 0;
      stockedLines.push({ ri, acceptedQty, unitCost, lineValue: Math.round(acceptedQty * unitCost * 100) / 100 });
      inventoryValue = Math.round((inventoryValue + acceptedQty * unitCost) * 100) / 100;
    }

    if (stockedLines.length === 0) {
      grn.inventoryApplied = true;
      grn.inventoryAppliedAt = new Date();
      await grn.save();
      return;
    }

    const invAcc = await this._ensureAccount(grn.businessId, '1150');
    const grniAcc = await this._ensureAccount(grn.businessId, '2115');
    if (!invAcc || !grniAcc) {
      throw new ApiError(400, `Cannot receive ${grn.grnNumber}: Inventory (1150) or Goods Received Not Invoiced (2115) account is missing.`);
    }

    const applied = [];
    await withTransaction(async (s) => {
      const je = await postCompoundJournal({
        businessId:        grn.businessId,
        transactionDate:   new Date(),
        description:       `Goods received — ${grn.grnNumber}`,
        transactionType:   TRANSACTION_TYPES.JOURNAL_ENTRY,
        transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
        createdBy:         user._id,
        lastModifiedBy:    user._id,
        idempotencyKey:    `grn:accrual:${grn._id}`,
        lines: [
          { accountId: invAcc._id,  type: 'debit',  amount: inventoryValue, description: 'Inventory received' },
          { accountId: grniAcc._id, type: 'credit', amount: inventoryValue, description: 'Goods received not invoiced' },
        ],
      }, { session: s });

      for (const { ri, acceptedQty, unitCost } of stockedLines) {
        await inventoryService.applyPurchaseStock(
          grn.businessId, ri.inventoryItemId, acceptedQty, unitCost,
          { userId: user._id, vendorId: grn.vendorId || null, session: s },
        );
        applied.push({ inventoryItemId: ri.inventoryItemId, name: ri.name, qty: acceptedQty, unitCost });
      }

      grn.glJournalId        = je._id;
      grn.inventoryApplied   = true;
      grn.inventoryAppliedAt = new Date();
      await grn.save({ session: s });
    });

    if (applied.length > 0) {
      // best-effort: analytics/forecasting broadcast; never blocks the receipt.
      businessEvents.emit(EVENTS.GOODS_RECEIVED, {
        businessId: grn.businessId.toString(), userId: user._id,
        entityType: ENTITY_TYPES.GOODS_RECEIPT, entityId: grn._id,
        grnNumber: grn.grnNumber, items: applied,
      });
    }
  }
```
Ensure `grn.glJournalId` exists on the GoodsReceipt schema; if not, add `glJournalId: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null }` to `models/GoodsReceipt.model.js`. Confirm `TRANSACTION_TYPES`, `TRANSACTION_SOURCES`, `ENTITY_TYPES`, `EVENTS`, `businessEvents`, `ApiError`, `logger` are imported (add any missing). Match the exact `EVENTS.GOODS_RECEIVED` payload shape the original emitted (read lines 331-340 before editing and preserve the fields downstream subscribers read).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- goodsReceipt.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add models/InventoryItem.model.js models/GoodsReceipt.model.js services/inventory.service.js services/goodsReceipt.service.js tests/unit/services/goodsReceipt.service.test.js
git commit -m "feat(grn): post DR Inventory/CR GRNI atomically at receipt, stop swallowing (audit A13/A14)"
```

---

### Task 10: Bill approval clears GRNI for the received-stock portion (split rule)

**Files:**
- Modify: `services/bill.service.js:567-715` (`postApLiabilityJournal`)
- Test: `tests/unit/services/bill.service.test.js` (existing)

**Interfaces:**
- Consumes: `postCompoundJournal(payload, { session })`; `_ensureAccount(businessId, '2115')` (add the same helper/method to bill.service as in Task 9); the bill's linked GRNs to compute received-stock value.
- Produces: `postApLiabilityJournal` posts ONE compound entry instead of separate primary+tax entries: DR GRNI (received-stock portion) + DR Expense/Inventory (remainder) + DR Input Tax (if any) / CR Accounts Payable (bill total).

**Split rule (implement exactly):**
- `grniValue = Σ over the bill's linked GRNs of their posted accrual value`, capped at the bill's stocked-line subtotal: `grniDebit = round2(min(Σ linked-GRN stocked value, billStockedSubtotal))`.
- `expenseDebit = round2(billNetSubtotal − grniDebit)` (net = total − tax). Never negative; if the bill has no GRN, `grniDebit = 0` and the whole net goes to expense (back-compat).
- `taxDebit = round2(bill.taxAmount || 0)`.
- `apCredit = round2(grniDebit + expenseDebit + taxDebit)` — must equal the bill's posted total; the compound poster will reject it otherwise (good — that's the balance guard).

Compute `Σ linked-GRN stocked value` from the GRNs linked to this bill. Find them via the bill's `purchaseOrderId` → confirmed GRNs with a `glJournalId` (their accrual amount = the GL entry's debit, or recompute Σ acceptedQty×unitCost). Read how bills reference GRNs/POs in this codebase (`git grep -n "purchaseOrderId\|grnId\|goodsReceipt" models/Bill.model.js services/bill.service.js`) before implementing; use whatever link already exists. If no linkage exists at all, `grniDebit = 0` (degrade to current behavior) and note it for the final review.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/services/bill.service.test.js`:
```js
test('postApLiabilityJournal clears GRNI for received stock and expenses the remainder', async () => {
  // Bill: net 1000 (stocked 800 backed by a GRN + 200 services), tax 0.
  const bill = buildBill({
    billNumber: 'BILL-GRNI', amount: 1000, totalAmount: 1000, taxAmount: 0,
    apLiabilityJournalId: null, linkedJournalEntryId: null,
    lineItems: [
      { inventoryItemId: 'item1', quantity: 8, unitPrice: 100, accountId: null }, // 800 stocked
      { inventoryItemId: null, quantity: 1, unitPrice: 200, accountId: 'exp1' },   // 200 service
    ],
  });
  service._ensureAccount = jest.fn().mockResolvedValue({ _id: 'grni1', accountCode: '2115' });
  // Stub the linked-GRN value lookup the implementation uses to return 800.
  service._linkedGrniValue = jest.fn().mockResolvedValue(800);
  ChartOfAccount.findOne.mockImplementation(({ accountCode }) => {
    if (accountCode === '2110') return Promise.resolve({ _id: 'ap1' });
    return Promise.resolve({ _id: 'exp1' });
  });

  await service.postApLiabilityJournal(bill, { _id: 'u1' }, '0.0.0.0');

  expect(postCompoundJournal).toHaveBeenCalledWith(
    expect.objectContaining({
      lines: expect.arrayContaining([
        expect.objectContaining({ accountId: 'grni1', type: 'debit', amount: 800 }),
        expect.objectContaining({ accountId: 'exp1',  type: 'debit', amount: 200 }),
        expect.objectContaining({ accountId: 'ap1',   type: 'credit', amount: 1000 }),
      ]),
    }),
    expect.objectContaining({ session: expect.anything() }),
  );
});

test('postApLiabilityJournal with no GRN debits the full net to expense (back-compat)', async () => {
  const bill = buildBill({ billNumber: 'BILL-NOGRN', amount: 500, totalAmount: 500, taxAmount: 0,
    apLiabilityJournalId: null, linkedJournalEntryId: null,
    lineItems: [{ inventoryItemId: null, quantity: 1, unitPrice: 500, accountId: 'exp1' }] });
  service._ensureAccount = jest.fn().mockResolvedValue({ _id: 'grni1' });
  service._linkedGrniValue = jest.fn().mockResolvedValue(0);
  ChartOfAccount.findOne.mockImplementation(({ accountCode }) =>
    Promise.resolve({ _id: accountCode === '2110' ? 'ap1' : 'exp1' }));

  await service.postApLiabilityJournal(bill, { _id: 'u1' }, '0.0.0.0');

  const call = postCompoundJournal.mock.calls.at(-1)[0];
  expect(call.lines.find(l => l.accountId === 'grni1')).toBeUndefined(); // no GRNI leg
  expect(call.lines).toEqual(expect.arrayContaining([
    expect.objectContaining({ accountId: 'exp1', type: 'debit', amount: 500 }),
    expect.objectContaining({ accountId: 'ap1', type: 'credit', amount: 500 }),
  ]));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- bill.service`
Expected: FAIL — current code posts a 2-account primary + separate tax entry, never a GRNI debit.

- [ ] **Step 3: Write minimal implementation**

Add to `bill.service.js`: the `_ensureAccount` method (same as Task 9) and a `_linkedGrniValue(bill)` helper that returns Σ posted accrual value of the GRNs linked to this bill (capped at the stocked subtotal). Then replace the body of `postApLiabilityJournal` from the AP-account lookup through the `withTransaction` block with a single compound post. Keep the idempotent guard at the top (`if (bill.apLiabilityJournalId || bill.linkedJournalEntryId) return null;`).

```js
    const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
    const businessId = bill.businessId;

    const apAccount = await ChartOfAccount.findOne({ businessId, accountCode: '2110' }).lean();
    if (!apAccount) {
      logger.warn(`[bill] AP journal skipped for ${bill.billNumber} — Accounts Payable (2110) not found`);
      return null;
    }

    // Resolve the expense/inventory debit account (line account → purchases → fallback).
    let expenseAccountId = null;
    if (bill.lineItems && bill.lineItems.length > 0) {
      const firstWithAccount = bill.lineItems.find((li) => li.accountId);
      if (firstWithAccount) expenseAccountId = firstWithAccount.accountId;
    }
    if (!expenseAccountId) {
      const purchasesAcc = await ChartOfAccount.findOne({ businessId, accountCode: { $in: ['5100', '5000', '6100'] } }).lean();
      if (purchasesAcc) expenseAccountId = purchasesAcc._id;
    }

    const taxAmount = r2(bill.taxAmount || 0);
    const netAmount = r2(bill.amount || (bill.totalAmount - taxAmount));
    const billNet = netAmount > 0 ? netAmount : r2(bill.totalAmount - taxAmount);

    // Stocked-line subtotal (lines that hit inventory) bounds how much GRNI we can clear.
    const stockedSubtotal = r2((bill.lineItems || [])
      .filter((li) => li.inventoryItemId)
      .reduce((s, li) => s + Number(li.quantity || 0) * Number(li.unitPrice || 0), 0));

    const linkedGrni = r2(await this._linkedGrniValue(bill));
    const grniDebit = r2(Math.min(linkedGrni, stockedSubtotal));
    const expenseDebit = r2(billNet - grniDebit);

    // Build the compound lines.
    const lines = [];
    if (grniDebit > 0) {
      const grniAcc = await this._ensureAccount(businessId, '2115');
      if (!grniAcc) throw new ApiError(400, `Cannot post ${bill.billNumber}: GRNI (2115) account missing.`);
      lines.push({ accountId: grniAcc._id, type: 'debit', amount: grniDebit, description: 'Clear goods received not invoiced' });
    }
    if (expenseDebit > 0.0001) {
      if (!expenseAccountId) {
        logger.warn(`[bill] AP journal skipped for ${bill.billNumber} — no expense account for the non-GRNI remainder`);
        return null;
      }
      lines.push({ accountId: expenseAccountId, type: 'debit', amount: expenseDebit, description: 'Purchase / expense' });
    }
    if (taxAmount > 0) {
      const inputTaxAcc = await ChartOfAccount.findOne({ businessId, accountCode: { $in: ['1170', '1171', '1172'] } }).lean();
      if (inputTaxAcc) lines.push({ accountId: inputTaxAcc._id, type: 'debit', amount: taxAmount, description: 'Recoverable input tax' });
    }
    const apCredit = r2(lines.filter(l => l.type === 'debit').reduce((s, l) => s + l.amount, 0));
    lines.push({ accountId: apAccount._id, type: 'credit', amount: apCredit, description: 'Accounts payable' });

    let primaryJe = null;
    const preLinked = bill.linkedJournalEntryId;
    try {
      await withTransaction(async (session) => {
        primaryJe = await postCompoundJournal({
          businessId,
          transactionDate:   bill.issueDate,
          description:       `AP Liability — ${bill.billNumber}${bill.vendorSnapshot?.vendorName ? ' (' + bill.vendorSnapshot.vendorName + ')' : ''}`,
          transactionType:   TRANSACTION_TYPES.CREDIT_PURCHASE,
          transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
          invoiceNumber:     bill.billNumber,
          vendorId:          bill.vendorId || null,
          currencyCode:      bill.currencyCode || 'PKR',
          exchangeRate:      bill.exchangeRate || 1,
          createdBy:         user._id,
          lastModifiedBy:    user._id,
          taxAmount:         taxAmount || 0,
          isProjection:      true,
          projectionOf:      { documentType: 'bill', documentId: bill._id },
          idempotencyKey:    `bill:ap:${bill._id}`,
          lines,
        }, { session });

        bill.apLiabilityJournalId = primaryJe._id;
        if (!bill.linkedJournalEntryId) bill.linkedJournalEntryId = primaryJe._id;
        await bill.save({ session });

        if (bill.vendorId && apCredit > 0) {
          await partyBalanceService.adjustPayable(businessId, bill.vendorId, apCredit, {
            userId: user._id, reason: 'bill_approved', entityType: ENTITY_TYPES.BILL, entityId: bill._id, session,
          });
        }
      });
    } catch (e) {
      bill.apLiabilityJournalId = undefined;
      bill.linkedJournalEntryId = preLinked;
      logger.error(`[bill] AP recognition rolled back for ${bill.billNumber}: ${e.message}`);
      throw e;
    }
    return primaryJe;
```

Implement `_linkedGrniValue(bill)`:
```js
  // Σ posted GRNI accrual value of the GRNs feeding this bill (capped by caller).
  // Returns 0 when the bill has no confirmed-GRN linkage (degrades to expense-only).
  async _linkedGrniValue(bill) {
    if (!bill.purchaseOrderId) return 0;
    const GoodsReceipt = require('../models/GoodsReceipt.model');
    const grns = await GoodsReceipt.find({
      businessId: bill.businessId, purchaseOrderId: bill.purchaseOrderId, glJournalId: { $ne: null },
    }).lean();
    let total = 0;
    for (const grn of grns) {
      for (const ri of (grn.receivedItems || [])) {
        if (!ri.inventoryItemId) continue;
        const acceptedQty = Math.max(0, Number(ri.quantityReceived || 0) - Number(ri.quantityRejected || 0));
        total += acceptedQty * (Number(ri.unitCost) || 0);
      }
    }
    return Math.round(total * 100) / 100;
  }
```
Verify the bill→PO field name (`bill.purchaseOrderId`) against `models/Bill.model.js` before relying on it; adjust if the codebase names it differently.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- bill.service`
Expected: PASS. The Task 6 gating tests and the prior AP-swallow test must still pass.

- [ ] **Step 5: Commit**

```bash
git add services/bill.service.js tests/unit/services/bill.service.test.js
git commit -m "feat(bill): clear GRNI for received-stock portion on approval (audit A13 split rule)"
```

---

### Task 11: GRN cancel reverses its GRNI journal + integration drift check

**Files:**
- Modify: `services/goodsReceipt.service.js` (the cancel/void path — find it via `git grep -n "cancel\|void\|CANCELLED" services/goodsReceipt.service.js`)
- Test: `tests/integration/grnBillLifecycle.test.js` (create) — full GRN→bill→pay lifecycle, asserts drift 0

**Interfaces:**
- Consumes: `transactionService.reverseTransaction(grn.glJournalId, businessId, { reason }, userId, ip)` (Task 1); the existing stock-reversal logic.
- Produces: cancelling a confirmed GRN reverses its DR Inventory/CR GRNI entry and its stock, so a cancelled receipt nets to zero in the GL.

- [ ] **Step 1: Write the failing test**

Read the current cancel path first. Then add a unit test asserting cancel reverses `grn.glJournalId`:
```js
test('cancel reverses the GRNI journal when one was posted', async () => {
  const grn = buildGrn({ state: 'confirmed', grnNumber: 'GRN-C', glJournalId: 'grnJe1', inventoryApplied: true });
  service._loadOrThrow = jest.fn().mockResolvedValue(grn);
  service._applyStateChange = jest.fn().mockResolvedValue(grn);
  const transactionService = require('../../../services/transaction.service');
  const revSpy = jest.spyOn(transactionService, 'reverseTransaction').mockResolvedValue({ _id: 'rev1' });

  await service.cancel(grn._id, { _id: 'u1', businessId: 'b1' }, 'wrong delivery', '0.0.0.0');

  expect(revSpy).toHaveBeenCalledWith('grnJe1', expect.anything(), expect.objectContaining({ reason: expect.any(String) }), 'u1', '0.0.0.0');
});
```
(If GRN has no cancel path today, add a minimal `cancel(id, user, reason, ipAddress)` that reverses stock + the GL entry + sets state CANCELLED — mirror the bill cancel pattern. Confirm with the final review whether GRN cancellation is in scope for the UI; the GL-correctness method should exist regardless.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- goodsReceipt.service`
Expected: FAIL — cancel does not reverse the GRNI journal.

- [ ] **Step 3: Write minimal implementation**

In the GRN cancel path, before/with the state change, reverse the accrual if present:
```js
    if (grn.glJournalId) {
      const transactionService = require('./transaction.service');
      await transactionService.reverseTransaction(
        grn.glJournalId.toString(), grn.businessId.toString(),
        { reason: `GRN ${grn.grnNumber} cancelled` }, user._id, ipAddress
      );
      grn.glJournalId = null;
    }
```
Also reverse the physical stock (Σ acceptedQty back out via `inventoryService.reduceStock`, or the existing reversal helper) and clear `grn.inventoryApplied` so the receipt nets to zero. Re-throw on failure (no swallow).

- [ ] **Step 4: Write the lifecycle integration test + run**

Create `tests/integration/grnBillLifecycle.test.js`: seed a business with default accounts, create PO → confirm GRN (assert DR 1150 / CR 2115 posted) → approve Bill (assert DR 2115 / CR 2110, GRNI nets to 0) → pay Bill → compute `ledgerIntegrity.computeDrift(businessId)` and assert 0. Mirror the existing integration-test bootstrap (DB connect, seed defaults) used by other files in `tests/integration/`.

Run: `npm test -- goodsReceipt.service grnBillLifecycle`
Expected: PASS.

- [ ] **Step 5: Full suite + drift + commit**

Run: `npm test` (full) then `node scripts/ledgerDrift.js`
Expected: all green; drift 0 across all businesses.
```bash
git add services/goodsReceipt.service.js tests/integration/grnBillLifecycle.test.js
git commit -m "feat(grn): reverse GRNI accrual on cancel; lifecycle drift test (audit A13)"
```

---

## Final whole-branch review

After Task 11: dispatch the final code reviewer (superpowers:requesting-code-review) on the full branch diff (`git merge-base main HEAD` → `HEAD`) using the most capable model. Focus areas: (1) no money/GL/balance/subledger write is left in a swallowing catch; (2) every system posting is idempotent and balanced; (3) the GRNI split rule balances to AP in all four cases (full match, partial receive, over-bill, no-GRN); (4) drift reads 0 after the lifecycle test; (5) the documented session-threading of the inventory subledger is correct (no orphaned writes outside the transaction that affect reported balances). Then use superpowers:finishing-a-development-branch.

## Non-goals (deliberate)

- **T2** period-query caching — caching a period-lock check is correctness-sensitive (a just-closed period could wrongly accept a write). Documented non-fix.
- **Frontend surfacing of the A12 override** — backend API supports it; the UI affordance is a follow-up.
- **Per-line GRNI reconciliation** beyond the value-split rule in Task 10 — line-level GRNI matching is a future enhancement.
- **Full Mongo-transaction atomicity of every inventory event emit** — event emits stay best-effort outside the session by design; the balance-affecting subledger writes (addStock/reduceStock) ARE session-threaded.

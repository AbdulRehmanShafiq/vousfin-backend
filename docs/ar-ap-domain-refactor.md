# AR / AP Domain Model Refactor — Architecture Audit & Plan

> **Phase 1 — audit + planning only. No implementation in this document's scope.**
> Goal: evolve Invoice & Bill into true enterprise accounting documents on par with
> NetSuite / SAP B1 / Xero / QuickBooks Enterprise / Odoo.
> Builds on the completed 13-step ERP Integration Refactor (see
> `ERP_INTEGRATION_SUMMARY.md`). Companion audit: `systemDependencyMap.md`.

---

## 0. Files Audited

**Backend (models):** `Invoice.model.js`, `Bill.model.js`, `JournalEntry.model.js`,
`Customer.model.js`, `Vendor.model.js`, `ChartOfAccount.model.js`.
**Backend (services):** `invoice.service.js`, `bill.service.js`, `transaction.service.js`,
`partyBalance.service.js`, `ledgerPosting.service.js`, `journalGenerator.service.js`
(FX-only), `billMatching.service.js`, `billScheduler.service.js`,
`creditNote.service.js`, `vendorCredit.service.js`, `taxEngine.service.js`,
`audit.service.js`, `eventSubscribers.service.js`.
**Backend (controllers/routes):** `invoice.controller.js`/`invoice.routes.js`,
`bill.controller.js`/`bill.routes.js`, `audit.routes.js`.
**Backend (repos):** `customer.repository.js`, `vendor.repository.js`,
`auditLog.repository.js`, `transaction.repository.js`.
**Config:** `constants.js` (INVOICE_STATES, BILL_STATES, *_TRANSITIONS, PAYMENT_STATUS,
APPROVAL_STATUS, APPROVER_ROLES, AUDIT_ACTIONS).
**Frontend:** `ReceivablesPage.jsx`, `PayablesPage.jsx`, `InvoicesListPage.jsx`,
`BillsListPage.jsx`, `InvoiceEditor.jsx`/`BillEditor.jsx`, `InvoiceEditorPage.jsx`/
`BillEditorPage.jsx`, `InvoiceStatusBadge.jsx`, `ApprovalChip.jsx`,
`AccountingImpactPanel.jsx`, `SmartContextPanel.jsx`, `useInvoices.js`,
`useParties.js`, `ActivityTimelinePage.jsx`.

---

## 1. Current Architecture

```
                 ┌──────────────────────── TWO PARALLEL REPRESENTATIONS ───────────────────────┐
                 │                                                                              │
   DOCUMENT side │  Invoice / Bill collection (first-class state machine, approval, audit)      │
                 │     state: draft→…→paid · paidAmount · remainingBalance · approvalLog        │
                 │     arJournalId / apLiabilityJournalId / linkedJournalEntryId                │
                 │                                                                              │
   LEDGER  side  │  JournalEntry collection (the actual money-of-record for AR/AP aging)        │
                 │     transactionType CREDIT_SALE/PURCHASE · paymentStatus · remainingBalance  │
                 │     settlements[] · relatedTransactions[] · customerId / vendorId            │
                 └──────────────────────────────────────────────────────────────────────────────┘

   Creation paths (TWO):
     A. Document-first : invoice.createDraft → submit → approve → postArJournal (DR AR / CR Sales + tax)
     B. Transaction-first: transaction.createTransaction (CREDIT_SALE) → JE → invoice.syncFromJournalEntry (mirror doc)

   Payment paths (TWO, divergent):
     • transaction.recordPartialPayment → child JE + parent.settlements[] + partyBalance.adjust  (updates JE, NOT the doc)
     • invoice/bill.markPaid → sets paidAmount=total, state=paid + settlement JE                 (updates doc, full-only)

   AR/AP balances : Customer.currentReceivableBalance / Vendor.currentPayableBalance
                    mutated centrally by partyBalance.service (Step 4) + *_BALANCE_CHANGED events.

   Reporting reads:
     • ReceivablesPage / PayablesPage  → GET /transactions/outstanding-balances  (JournalEntry-derived)
     • InvoicesListPage / BillsListPage → GET /invoices, /bills                   (document-derived)
```

**State enums today**

- `INVOICE_STATES`: draft, pending_approval, approved, sent, partially_paid, paid, overdue, cancelled, disputed, written_off.
- `BILL_STATES`: draft, awaiting_approval, approved, scheduled, partially_paid, paid, overdue, cancelled.
- `PAYMENT_STATUS` (separate, on JournalEntry): unpaid, partially_paid, paid, overdue.
- `APPROVAL_STATUS`: not_required, pending, approved, rejected. `APPROVER_ROLES`: owner/accountant/manager/admin (**defined, not enforced**).

---

## 2. Audit Findings — Problems Identified

### P1 — Split-brain AR/AP (the central issue)
Two sources of truth for "what is owed." The **document** (Invoice/Bill) and the
**ledger** (JournalEntry) are kept loosely in sync by dual-write, but:
- `transaction.recordPartialPayment` updates the **JE** `remainingBalance`/`settlements`
  and the party balance, **but never updates the Invoice/Bill** `paidAmount`/`state`.
- Result: an invoice paid via the Receivables page (transaction path) still shows
  `state: approved/sent` with `remainingBalance: full` on the **document**, while the
  ledger shows it settled. The two AR/AP list pages can show contradictory numbers.

### P2 — Inconsistent status enums
- Dual status systems: document `state` vs JE `paymentStatus`. `paid`/`overdue` exist in
  both with different ownership.
- `INVOICE_TRANSITIONS`/`BILL_TRANSITIONS` reference a `rejected` key/target that is
  **not** a member of `INVOICE_STATES`/`BILL_STATES` (reject() actually routes to `draft`)
  → dead/inconsistent transition entries.
- `AUDIT_ACTIONS` are Title-Case strings while states are snake_case — mixed conventions.

### P3 — No first-class Payment entity
Payments are modelled as **child JournalEntries + `settlements[]` subdocs** on the parent
JE. There is no `Payment` document, no payment **allocation across multiple invoices**,
no payment method/reference as a queryable record, and the Invoice/Bill carry no
`payments[]`. Enterprise AR/AP needs a Payment/Receipt object with line-level application.

### P4 — Weak payment flow on the document
`invoice/bill.markPaid` is **full-payment only** (`paidAmount = totalAmount`). No
document-level partial payment, no payment schedule, no remaining-balance maintenance
from real receipts. Partial payments only exist on the JE side (P1).

### P5 — Approval workflow is single-level & unenforced
`approvalRequired`/`approvalStatus`/`approvalLog`/`approvalThreshold` exist, but:
- Only **one** approval step (no sequential/multi-tier chains by amount band).
- `APPROVER_ROLES` are **not enforced** — any authenticated user can call `/approve`.
- No segregation of duties (creator can approve own document), no delegation, no
  per-role approval limits.

### P6 — Missing validations
- **Invoice** has **no duplicate-number guard** in the service (only the DB unique index;
  Bill has Phase-3.2 duplicate detection — asymmetric).
- No customer **credit-limit** enforcement (Customer has no creditLimit field consulted).
- No line-item validation (negative qty/price), no `dueDate ≥ issueDate` check, no
  currency consistency check (header vs lines vs FX).
- No guard preventing edits to a document whose JE is in a **locked accounting period**
  on the document path (transaction path checks periods; document path does not).

### P7 — Direct transaction coupling
Invoice/Bill are partly **derived from** transaction.service via `syncFromJournalEntry`.
The dual creation + dual payment paths mean the document layer is not authoritative; it
is a projection that can drift (P1). Recognition journals were centralized in Step 4
(`postArJournal`/`postApLiabilityJournal` + `ledgerPosting`), which is good, but payment
and void are still ledger-coupled.

### P8 — Deletion / void semantics inconsistent
- Invoice/Bill have **soft delete** (`isArchived`) ✓.
- But there is **no "void"** that reverses the posted AR/AP journal and unwinds the party
  balance at the document level (cancel only flips state; the reversing JE is only done via
  the transaction-reversal path). NetSuite/Xero distinguish **void** (reverses GL) vs
  **delete** (draft only) vs **credit memo** (offsetting document).

### P9 — Reporting dependencies fragmented
AR/AP aging, customer statements and the Receivables/Payables UI read from
`transaction.outstanding-balances` (JE), while document lists read from Invoice/Bill.
A single reconciled read model does not exist.

### P10 — Enterprise feature gaps
- **Invoice** has no recurring schedule (Bill has `billScheduler`); no sales-order upstream
  (AR equivalent of PO→Bill); no customer statement generated from documents.
- Credit notes (`creditNote.service`) and vendor credits exist but linkage to the
  originating Invoice/Bill at the document level is loose.
- No dunning/collections workflow on the document; no multi-currency revaluation per open
  document; no payment-terms engine (net 30/60, early-pay discount) driving dueDate.

---

## 3. Target Architecture (enterprise)

```
   SINGLE SOURCE OF TRUTH = the Invoice / Bill DOCUMENT.
   The JournalEntry becomes the document's immutable GL projection (generated, never the master).

   Invoice / Bill  ──posts──▶  Recognition JE   (DR AR / CR Sales+tax  |  DR exp/inv+tax / CR AP)
        │                                         via ledgerPosting (balanced + running-balance synced)
        │
        ├── Payment / Receipt (NEW first-class entity)
        │       applications[] : allocate one receipt across many invoices/bills
        │       ──posts──▶ Settlement JE (DR Cash / CR AR  |  DR AP / CR Cash)
        │       ──updates──▶ document.paidAmount / remainingBalance / derived paymentStatus
        │       ──updates──▶ partyBalance.adjust* (+ *_BALANCE_CHANGED event)
        │
        ├── Void  ──posts──▶ reversing JE + partyBalance unwind + state=voided
        ├── Credit Memo / Vendor Credit ── linked, offsets the document
        └── Approval chain (multi-tier, role-enforced, SoD)
```

Key shifts:
1. **Unify status** → one document lifecycle `state` + a **derived** `paymentStatus`
   computed from `paidAmount`/`remainingBalance` (drop the parallel JE-owned status as the
   AR/AP authority for documents; JE keeps its own for non-document journals).
2. **Payment becomes first-class** (`Payment` model) with multi-document application; all
   payment paths (Receivables page, document markPaid, transaction recordPartialPayment)
   funnel through one `paymentService`.
3. **Documents own their lifecycle**; JE is generated and reconciled, never edited
   independently for document money.
4. **Multi-level approval** with role limits + segregation of duties.
5. **Void / credit-memo** as distinct, GL-correct operations.

---

## 4. Migration Strategy (incremental, non-breaking)

- **M0 (this commit):** audit + plan + checkpoint. No code change.
- **M1 — Reconcile the split-brain (highest priority, non-breaking):** add a
  reconciliation that backfills Invoice/Bill `paidAmount`/`remainingBalance`/`state` from
  the linked JE `settlements`. Add a derived `paymentStatus` virtual. Subscribe to
  `PAYMENT_RECORDED` so the document updates whenever a transaction-path payment settles
  its JE. *Closes P1 without changing APIs.*
- **M2 — Introduce `Payment` model + `paymentService`** behind new endpoints; have
  `transaction.recordPartialPayment` and `invoice/bill.markPaid` **delegate** to it
  (adapter), so existing callers keep working while a single path emerges.
- **M3 — Status unification:** add the derived `paymentStatus`, remove the dead `rejected`
  transition entries (add `rejected` as a proper state OR keep routing to draft —
  decide + document), normalize enum casing via a mapping layer (no breaking rename).
- **M4 — Approval engine:** add `approvals[]` chain + role/limit enforcement +
  segregation-of-duties guard; keep single-step as the default config.
- **M5 — Validations + void + credit-memo + recurring invoices.**
- **M6 — Unified AR/AP read model** for Receivables/Payables (reconciled view) + frontend
  switch.

Each M-step: own commit + push, tests, behind a feature flag where behavior changes.

---

## 5. Backward Compatibility Strategy

- **No endpoint removed or renamed.** New capabilities are additive routes.
- `transaction.recordPartialPayment` and `markPaid` remain but internally delegate to
  `paymentService` (adapter) — identical responses.
- Dual-write (`syncFromJournalEntry`) stays operational through M1–M4; removed only after
  the document layer is authoritative and verified.
- All migrations are **idempotent** (re-runnable) and guarded (skip already-reconciled
  documents via `linkedJournalEntryId`/`arJournalId`/`apLiabilityJournalId`).
- New model fields default to safe values; existing documents keep working unchanged.
- Feature flags (business config) gate role-enforced approvals + credit-limit blocking so
  current tenants aren't suddenly blocked.

---

## 6. Event Flow (new + reused)

Reuse the Step-2/7 event engine. New events to add to the taxonomy:

```
PAYMENT_APPLIED        payment.applied        → update doc paidAmount/state · partyBalance.adjust(−) · cache · audit
INVOICE_VOIDED         invoice.voided         → reversing JE · partyBalance unwind · cache · audit
BILL_VOIDED            bill.voided            → reversing JE · partyBalance unwind · cache · audit
CREDIT_MEMO_APPLIED    credit_memo.applied    → offset doc · partyBalance.adjust(−) · cache · audit
APPROVAL_REQUESTED     approval.requested     → notify approver(s)
APPROVAL_GRANTED       approval.granted       → advance chain / post recognition JE on final approval
APPROVAL_REJECTED      approval.rejected      → route to draft · notify creator
```
Existing `eventSubscribers` add these to `CACHE_INVALIDATING_EVENTS`; all remain
fire-and-forget + tenant-guarded.

---

## 7. Approval Workflow (target)

- `approvals[]` ordered chain: `[{ level, approverRole, threshold, status, actorId, actedAt, note }]`.
- Routing by **amount band** → required levels (e.g. ≤10k none; ≤100k accountant; >100k
  manager→owner sequential).
- **Role enforcement** in the controller/service (currently absent) + **segregation of
  duties** (creator ≠ final approver unless owner override).
- Recognition JE posts only on **final** approval (already true for single-step via
  `approve → postArJournal`); generalize to "final level granted".
- Delegation + out-of-office reassignment (later).

---

## 8. Audit Strategy (target)

Already strong on the document (`stateHistory`, `approvalLog`, `fieldHistory` +
`auditService.log`) and unified via the Step-9 timeline. Additions:
- Log **payment application**, **void**, **credit-memo**, and each **approval level** as
  discrete `AUDIT_ACTIONS` (add `PAYMENT_APPLIED`, `VOIDED`, `CREDIT_APPLIED`).
- Persist key events durably (an `EventLog` collection) so the activity trail survives
  restarts (currently in-memory ring buffer) — aligns with `ERP_INTEGRATION_SUMMARY.md` §7.
- Reconciliation actions logged so backfills are auditable.

---

## 9. DB Changes (planned, additive)

- **NEW `Payment` model**: `{ businessId, type: 'receipt'|'disbursement', partyType,
  partyId, paymentDate, amount, currencyCode, method, reference, cashAccountId,
  applications: [{ documentType:'invoice'|'bill', documentId, amount }], journalEntryId,
  status, createdBy, audit… }` + indexes `{businessId, partyId, paymentDate}`,
  `{businessId, 'applications.documentId'}`.
- **Invoice / Bill additions**: `paymentIds: [ObjectId]`, `voidedAt`, `voidReason`,
  `voidJournalEntryId`, `approvals: [chain]`, `paymentTerms` (net days / discount),
  `recurringScheduleId` (invoice), `creditMemoIds: [ObjectId]`; derived virtual
  `paymentStatus`.
- **Customer additions**: `creditLimit`, `creditHold` (for enforcement).
- **constants.js**: add the new events, `AUDIT_ACTIONS` (PAYMENT_APPLIED/VOIDED/
  CREDIT_APPLIED), an `INVOICE_STATES.VOIDED`/`BILL_STATES.VOIDED`, and fix the dead
  `rejected` transition entries.
- **Migrations (migrate-mongo)**: (a) backfill doc paid/remaining/state from JE settlements;
  (b) seed `paymentStatus`; (c) create indexes. All idempotent.

---

## 10. API Compatibility (planned)

**Unchanged** (kept verbatim): all current
`/invoices/*` (createDraft, list, getById, timeline, pdf, updateDraft, submit, approve,
reject, send, cancel, dispute, write-off, transition, DELETE) and
`/bills/*` (… schedule, match …).

**New, additive:**
```
POST /invoices/:id/payments      apply a receipt (partial/full, multi-allocation)
POST /bills/:id/payments         apply a disbursement
POST /invoices/:id/void          GL-correct void (reverses AR JE)
POST /bills/:id/void
POST /invoices/:id/credit-memo   link/issue an offsetting credit
GET  /payments                   list payments (filterable)
GET  /ar-ap/aging                unified reconciled aging read model
POST /invoices/:id/recurring     recurring schedule (mirror billScheduler)
```
`/transactions/recordPayment` stays but delegates to `paymentService`.

---

## 11. Affected Files (for the eventual implementation)

**Backend — modify:** `models/Invoice.model.js`, `models/Bill.model.js`,
`models/Customer.model.js`, `config/constants.js`, `services/invoice.service.js`,
`services/bill.service.js`, `services/transaction.service.js` (delegate payments),
`services/partyBalance.service.js` (reuse), `services/eventSubscribers.service.js`
(new events), `controllers/invoice.controller.js`, `controllers/bill.controller.js`,
`routes/v1/invoice.routes.js`, `routes/v1/bill.routes.js`, `services/audit.service.js`.
**Backend — new:** `models/Payment.model.js`, `services/payment.service.js`,
`repositories/payment.repository.js`, `controllers/payment.controller.js`,
`routes/v1/payment.routes.js`, `services/arApReconciliation.service.js`,
`migrations/*-backfill-doc-payments.js`, plus unit + integration tests.
**Frontend — modify:** `ReceivablesPage.jsx`, `PayablesPage.jsx`, `InvoiceEditor.jsx`,
`BillEditor.jsx`, `useInvoices.js`, `useParties.js`, `InvoiceStatusBadge.jsx`,
`SmartContextPanel.jsx`/`contextualEngine.js` (payment-aware recommendations).
**Frontend — new:** `payment.service.js`, `usePayments.js`, a `RecordPaymentModal`
with allocation, an AR/AP aging view bound to the reconciled endpoint.

---

## 12. Recommended Implementation Order

1. **M1 — Reconciliation (close split-brain P1).** Subscribe documents to
   `PAYMENT_RECORDED`; backfill migration; derived `paymentStatus`. *Highest value,
   lowest risk, no API change.*
2. **M2 — `Payment` model + `paymentService`** + delegate existing payment paths to it.
3. **M3 — Status unification + enum cleanup** (P2): derived paymentStatus everywhere,
   fix dead `rejected` transitions, add `voided` state.
4. **M4 — Validations** (P6): invoice duplicate guard, dueDate, line-item, currency,
   credit-limit (flagged).
5. **M5 — Void + credit-memo** (P8) as GL-correct operations + events.
6. **M6 — Multi-level approval engine + role/SoD enforcement** (P5).
7. **M7 — Unified AR/AP aging read model** + Receivables/Payables rebind (P9).
8. **M8 — Enterprise extras** (P10): recurring invoices, payment terms/discounts,
   customer statements, dunning.
9. **M9 — Durable event log** + remove dual-write once documents are authoritative (P7).

Each step: feature-flagged where behavior changes · unit + integration tests · commit +
push · UI/UX touch · backward-compatible.

---

*End of Phase 1 audit & plan. Implementation deferred to subsequent phases.*

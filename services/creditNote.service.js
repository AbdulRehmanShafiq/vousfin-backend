// services/creditNote.service.js
//
// Phase 2 — Credit Note / Debit Note lifecycle service.
//
// Public API:
//   create(data, user, ip)       → CreditNote (state=draft)
//   approve(id, user, ip)        → CreditNote (state=approved, updates Invoice.totalCredited)
//   apply(id, user, ip)          → CreditNote (state=applied, adjusts Invoice.remainingBalance)
//   cancel(id, user, ip)         → CreditNote (state=cancelled, reverses credit)
//   getById(id, businessId)      → CreditNote
//   listByInvoice(invoiceId, biz)→ CreditNote[]
//   list(businessId, filters)    → { data, total }
//

const mongoose = require('mongoose');
const CreditNote = require('../models/CreditNote.model');
const Invoice = require('../models/Invoice.model');
const ChartOfAccount = require('../models/ChartOfAccount.model');
const customerRepository = require('../repositories/customer.repository');
const auditService = require('./audit.service');
const partyBalanceService = require('./partyBalance.service');
const openItemService = require('./openItem.service');
const { toBaseAmount } = require('../utils/currency.util'); // F2 — ledger is base currency
const accountResolver = require('./accountResolver.service'); // I-9 — heal-or-refuse, never regex-guess
const { postBalancedJournal } = require('./ledgerPosting.service');
const { withTransaction } = require('../utils/withTransaction');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const { ENTITY_TYPES, AUDIT_ACTIONS, TRANSACTION_TYPES } = require('../config/constants');

class CreditNoteService {
  // ───────────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────────

  async _loadOrThrow(id, businessId = null) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, 'Invalid credit note id');
    }
    // R-05: tenant scope when provided
    const cn = businessId
      ? await CreditNote.findOne({ _id: id, businessId })
      : await CreditNote.findById(id);
    if (!cn) throw new ApiError(404, 'Credit note not found');
    if (cn.isArchived) throw new ApiError(410, 'Credit note has been archived');
    return cn;
  }

  async _customerSnapshot(businessId, customerId) {
    if (!customerId) return {};
    const c = await customerRepository.findByBusinessAndId(businessId, customerId);
    if (!c) return {};
    return {
      fullName:     c.fullName || null,
      businessName: c.businessName || null,
      email:        c.email || null,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Create
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Create a credit note (or debit note) linked to an invoice.
   * Validates that the credit amount does not exceed the invoice's remaining creditable balance.
   */
  async create(data, user, ipAddress) {
    if (!data.businessId || !data.invoiceId || !data.creditNoteNumber || !data.issueDate) {
      throw new ApiError(400, 'create requires: businessId, invoiceId, creditNoteNumber, issueDate');
    }

    // Load originating invoice
    const invoice = await Invoice.findOne({
      _id: data.invoiceId,
      businessId: data.businessId,
    });
    if (!invoice) throw new ApiError(404, 'Originating invoice not found');

    // Validate credit amount does not exceed what's creditable
    const hasLines = Array.isArray(data.lineItems) && data.lineItems.length > 0;
    const estimatedTotal = hasLines
      ? data.lineItems.reduce((s, li) => s + (li.quantity || 0) * (li.unitPrice || 0), 0)
      : data.totalAmount || 0;

    if (data.noteType !== 'debit_note') {
      const alreadyCredited = invoice.totalCredited || 0;
      const maxCreditable = invoice.totalAmount - alreadyCredited;
      if (estimatedTotal > maxCreditable + 0.01) {
        throw new ApiError(400, `Credit amount (${estimatedTotal}) exceeds remaining creditable balance (${maxCreditable})`);
      }
    }

    const snap = await this._customerSnapshot(data.businessId, data.customerId || invoice.customerId);

    const cn = new CreditNote({
      businessId:        data.businessId,
      creditNoteNumber:  data.creditNoteNumber,
      noteType:          data.noteType || 'credit_note',
      invoiceId:         data.invoiceId,
      invoiceNumber:     invoice.invoiceNumber,
      customerId:        data.customerId || invoice.customerId || null,
      customerSnapshot:  snap,
      lineItems:         data.lineItems || [],
      subtotal:          0, // computed by pre-save
      taxAmount:         0,
      totalAmount:       data.totalAmount || 0.01, // pre-save overrides if lineItems
      currencyCode:      data.currencyCode || invoice.currencyCode || 'PKR',
      baseCurrencyCode:  invoice.baseCurrencyCode || 'PKR',
      exchangeRate:      data.exchangeRate || invoice.exchangeRate || 1,
      state:             'draft',
      issueDate:         data.issueDate,
      reason:            data.reason || null,
      notes:             data.notes || null,
      createdBy:         user._id,
      lastModifiedBy:    user._id,
    });

    await cn.save();

    try {
      await auditService.logCreate(
        ENTITY_TYPES.INVOICE, // grouped under invoice entity for audit trail
        cn._id,
        cn.businessId,
        user._id,
        cn.toObject(),
        ipAddress
      );
    } catch (e) {
      // best-effort: audit-log write is observability only; the credit note document was already persisted.
      logger.warn(`[creditNote] audit logCreate failed: ${e.message}`);
    }
    return cn;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Approve
  // ───────────────────────────────────────────────────────────────────────────

  async approve(id, user, ipAddress) {
    const cn = await this._loadOrThrow(id, user?.businessId);
    if (cn.state !== 'draft') {
      throw new ApiError(409, `Credit note cannot be approved from state "${cn.state}"`);
    }
    cn.state = 'approved';
    cn.approvedBy = user._id;
    cn.approvedAt = new Date();
    cn.lastModifiedBy = user._id;
    await cn.save();
    return cn;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Apply (adjusts invoice balances)
  // ───────────────────────────────────────────────────────────────────────────

  async apply(id, user, ipAddress) {
    const cn = await this._loadOrThrow(id, user?.businessId);
    if (cn.state !== 'approved') {
      throw new ApiError(409, `Credit note must be approved before applying (current: "${cn.state}")`);
    }

    // Update the originating invoice
    const invoice = await Invoice.findById(cn.invoiceId);
    if (!invoice) throw new ApiError(404, 'Originating invoice not found');

    // Re-validate the creditable limit at APPLY time using the CURRENT
    // totalCredited. The create-time guard reads totalCredited, but that field is
    // only incremented here at apply — so several notes drafted/approved against
    // one invoice each pass create (all seeing totalCredited=0) and, without this
    // re-check, would over-credit the invoice and drive the customer receivable
    // negative when applied in sequence. (Parallel to the payment over-allocation
    // guard.) Debit notes increase what's owed, so they are not capped here.
    if (cn.noteType === 'credit_note') {
      const alreadyCredited = invoice.totalCredited || 0;
      const maxCreditable = (invoice.totalAmount || 0) - alreadyCredited;
      if (cn.totalAmount > maxCreditable + 0.01) {
        throw new ApiError(400,
          `Cannot apply credit note ${cn.creditNoteNumber}: amount (${cn.totalAmount}) exceeds the invoice's remaining creditable balance (${Math.max(0, maxCreditable)}).`);
      }
    }

    // Resolve GL accounts BEFORE the transaction (I-9, heal-or-refuse): the
    // resolver may SEED a missing default, and a document created outside the
    // session is not visible to reads inside it — so resolution happens first,
    // posting second. All four codes are seeded defaults, so this either
    // returns an account or throws in plain language; the old name-regex
    // fallbacks re-modelled the exact scatter accountResolver exists to close.
    let salesReturnsAcct = null;
    let arAcct = null;
    let salesAcct = null;
    if (cn.noteType === 'credit_note') {
      [salesReturnsAcct, arAcct] = await Promise.all([
        accountResolver.resolve(cn.businessId, '4115'),
        accountResolver.resolve(cn.businessId, '1110'),
      ]);
    } else {
      [arAcct, salesAcct] = await Promise.all([
        accountResolver.resolve(cn.businessId, '1110'),
        accountResolver.resolve(cn.businessId, '4110'),
      ]);
    }

    // All-or-nothing (audit A9): the invoice update, the GL posting, the AR
    // adjustment and marking the note APPLIED must commit together. Previously the
    // GL post sat in a try/catch that swallowed failures, so an invoice could be
    // marked credited with no journal entry (document↔GL drift).
    await withTransaction(async (s) => {
      if (cn.noteType === 'credit_note') {
        invoice.totalCredited = (invoice.totalCredited || 0) + cn.totalAmount;
        invoice.remainingBalance = Math.max(0, (invoice.remainingBalance ?? invoice.totalAmount) - cn.totalAmount);
        if (!invoice.creditNoteIds) invoice.creditNoteIds = [];
        invoice.creditNoteIds.push(cn._id);
      } else {
        // Debit note: increases amount owed
        invoice.remainingBalance = (invoice.remainingBalance ?? invoice.totalAmount) + cn.totalAmount;
      }
      invoice.lastModifiedBy = user._id;
      await invoice.save({ session: s });

      // Post GL journal entry for credit_note: DR Sales Returns & Allowances / CR Accounts Receivable
      if (cn.noteType === 'credit_note') {
        // F2 (residual) — the ledger, party balance and open item are BASE
        // currency; the credit relieves the invoice's carrying value at its
        // BOOKING rate (IAS 21), exactly mirroring how payments settle.
        const bookingRate = Number(invoice.exchangeRate) > 0
          ? Number(invoice.exchangeRate)
          : (Number(cn.exchangeRate) > 0 ? Number(cn.exchangeRate) : 1);
        const creditBase = toBaseAmount(cn.totalAmount, bookingRate);
        // Accounts resolved before the transaction opened (see above).
        const je = await postBalancedJournal({
          businessId:         cn.businessId,
          transactionDate:    new Date(),
          description:        `Credit Note ${cn.creditNoteNumber} applied to ${cn.invoiceNumber || invoice.invoiceNumber}`,
          // A credit note applies to a given invoice once.
          idempotencyKey: `credit-note-apply:${cn._id}:${invoice._id}`,
          transactionType:    TRANSACTION_TYPES.REFUND,
          amount:             creditBase,
          debitAccountId:     salesReturnsAcct._id,
          creditAccountId:    arAcct._id,
          transactionSource:  'system_generated',
          status:             'posted',
          entryType:          'adjusting',
          createdBy:          user._id,
          lastModifiedBy:     user._id,
          currencyCode:       cn.currencyCode || 'PKR',
          baseCurrencyCode:   cn.baseCurrencyCode || 'PKR',
          exchangeRate:       bookingRate,
          baseCurrencyAmount: creditBase,
        }, { session: s });
        cn.linkedJournalEntryId = je._id;

        // Decrement the customer's receivable balance
        if (invoice.customerId) {
          await partyBalanceService.adjustReceivable(
            cn.businessId,
            invoice.customerId,
            -creditBase,
            {
              userId:     user._id,
              reason:     'credit_note_applied',
              entityType: 'creditNote',
              entityId:   cn._id,
              session:    s,
            }
          );
        }

        // Keep the RECOGNITION JE's open item in sync (audit F3): the payment
        // engine, aging report and VE-5 reconcile all read the JE's
        // remainingBalance — without this a fully-credited invoice could still
        // be collected in full.
        await openItemService.adjustOpenItem(
          cn.businessId,
          invoice.linkedJournalEntryId || invoice.arJournalId,
          -creditBase,
          { session: s }
        );

        // ── Inventory Engine Phase 3 (INV-2) — restock returned goods ──────
        // Lines flagged `restock` put the goods back into stock at the item's
        // current cost and reverse COGS by the same value (matching principle
        // mirror of the sale): DR Inventory 1150 / CR COGS 5110. One journal,
        // per-line movements, all inside THIS session.
        const restockLines = (cn.lineItems || []).filter(
          (li) => li.restock && li.inventoryItemId && Number(li.quantity) > 0
        );
        if (restockLines.length > 0) {
          const inventoryService = require('./inventory.service');
          const InventoryItem = require('../models/InventoryItem.model');
          const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

          const { cogsAccountId, inventoryAccountId } = await inventoryService.resolveCostAccounts(cn.businessId);
          if (!cogsAccountId || !inventoryAccountId) {
            throw new ApiError(400,
              'Cannot restock the returned goods: your chart of accounts is missing the Inventory (1150) or Cost of Goods Sold (5110) account. Restore the defaults in Chart of Accounts, then apply again.');
          }

          let restockValue = 0;
          const lineCosts = [];
          for (const li of restockLines) {
            const item = await InventoryItem.findOne({ _id: li.inventoryItemId, businessId: cn.businessId }).session(s);
            if (!item) throw new ApiError(404, `Returned item "${li.name}" was not found in your inventory`);
            const unitCost = Number(item.unitCostPrice) || 0;
            lineCosts.push({ li, unitCost });
            restockValue = r2(restockValue + Number(li.quantity) * unitCost);
          }

          if (restockValue > 0) {
            const restockJe = await postBalancedJournal({
              businessId:        cn.businessId,
              transactionDate:   new Date(),
              description:       `Returned goods restocked — Credit Note ${cn.creditNoteNumber}`,
              // Returned goods go back on the shelf once.
              idempotencyKey: `credit-note-restock:${cn._id}`,
              transactionType:   TRANSACTION_TYPES.REFUND,
              amount:            restockValue,
              debitAccountId:    inventoryAccountId,  // DR Inventory — goods are back
              creditAccountId:   cogsAccountId,       // CR COGS — cost reversed
              transactionSource: 'system_generated',
              status:            'posted',
              entryType:         'adjusting',
              createdBy:         user._id,
              lastModifiedBy:    user._id,
            }, { session: s });
            cn.restockJournalEntryId = restockJe._id;

            for (const { li, unitCost } of lineCosts) {
              await inventoryService.applyPurchaseStock(
                cn.businessId, li.inventoryItemId, Number(li.quantity), unitCost, {
                  session: s, userId: user._id,
                  movementType: 'sale_return',
                  source: { docType: 'CreditNote', docId: cn._id },
                  journalEntryId: restockJe._id,
                  notes: `Credit Note ${cn.creditNoteNumber}`,
                }
              );
            }
          }
        }
      } else if (cn.noteType === 'debit_note') {
        // Debit note = an additional charge to the customer. It was previously
        // document-only (remainingBalance += amount) with NO GL entry and no AR
        // adjustment — books understated revenue and receivable (audit F-gap).
        // Post DR Accounts Receivable / CR Sales, and raise the receivable.
        const bookingRate = Number(invoice.exchangeRate) > 0
          ? Number(invoice.exchangeRate)
          : (Number(cn.exchangeRate) > 0 ? Number(cn.exchangeRate) : 1);
        const debitBase = toBaseAmount(cn.totalAmount, bookingRate);
        // Accounts resolved before the transaction opened (see above).
        const je = await postBalancedJournal({
          businessId:         cn.businessId,
          transactionDate:    new Date(),
          description:        `Debit Note ${cn.creditNoteNumber} applied to ${cn.invoiceNumber || invoice.invoiceNumber}`,
          // A debit note applies to a given invoice once.
          idempotencyKey: `debit-note-apply:${cn._id}:${invoice._id}`,
          transactionType:    TRANSACTION_TYPES.CREDIT_SALE || 'Credit Sale',
          amount:             debitBase,
          debitAccountId:     arAcct._id,
          creditAccountId:    salesAcct._id,
          transactionSource:  'system_generated',
          status:             'posted',
          entryType:          'adjusting',
          createdBy:          user._id,
          lastModifiedBy:     user._id,
          currencyCode:       cn.currencyCode || 'PKR',
          baseCurrencyCode:   cn.baseCurrencyCode || 'PKR',
          exchangeRate:       bookingRate,
          baseCurrencyAmount: debitBase,
        }, { session: s });
        cn.linkedJournalEntryId = je._id;

        if (invoice.customerId) {
          await partyBalanceService.adjustReceivable(
            cn.businessId, invoice.customerId, debitBase,
            { userId: user._id, reason: 'debit_note_applied', entityType: 'creditNote', entityId: cn._id, session: s }
          );
        }
        // The extra charge adds to the invoice's open item so the payment engine
        // and aging see the higher amount due.
        await openItemService.adjustOpenItem(
          cn.businessId,
          invoice.linkedJournalEntryId || invoice.arJournalId,
          debitBase,
          { session: s }
        );
      }

      cn.state = 'applied';
      cn.lastModifiedBy = user._id;
      await cn.save({ session: s });
    });
    return cn;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Cancel
  // ───────────────────────────────────────────────────────────────────────────

  async cancel(id, user, reason, ipAddress) {
    const cn = await this._loadOrThrow(id, user?.businessId);
    if (cn.state === 'cancelled') return cn;

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

          // F2 — same base conversion as apply (party balance and open item are base).
          const bookingRate = Number(invoice.exchangeRate) > 0
            ? Number(invoice.exchangeRate)
            : (Number(cn.exchangeRate) > 0 ? Number(cn.exchangeRate) : 1);
          const creditBase = toBaseAmount(cn.totalAmount, bookingRate);

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
                cn.businessId, invoice.customerId, creditBase,
                { userId: user._id, reason: 'credit_note_cancelled', entityType: 'creditNote', entityId: cn._id, session: s }
              );
            } else if (cn.noteType === 'debit_note' && invoice.customerId) {
              // Mirror of apply: the JE reversal above unwinds the ledger; here we
              // lower the customer receivable back down by the extra charge.
              await partyBalanceService.adjustReceivable(
                cn.businessId, invoice.customerId, -creditBase,
                { userId: user._id, reason: 'debit_note_cancelled', entityType: 'creditNote', entityId: cn._id, session: s }
              );
            }
          }

          // Restore the recognition JE's open item (audit F3) — mirror of apply.
          if (cn.noteType === 'credit_note') {
            await openItemService.adjustOpenItem(
              cn.businessId,
              invoice.linkedJournalEntryId || invoice.arJournalId,
              creditBase,
              { session: s }
            );

            // Phase 3 — undo the restock: reverse the DR Inventory / CR COGS
            // journal and take the goods back OUT of stock. If some of the
            // restocked units were already sold, the cancel is refused (the
            // reduceStock guard throws) — never force stock negative.
            if (cn.restockJournalEntryId) {
              const inventoryService = require('./inventory.service');
              const transactionService2 = require('./transaction.service');
              await transactionService2.reverseTransaction(
                cn.restockJournalEntryId.toString(),
                cn.businessId.toString(),
                { reason: `Credit note ${cn.creditNoteNumber} cancelled — restock undone`, session: s },
                user._id,
                ipAddress
              );
              const restockLines = (cn.lineItems || []).filter(
                (li) => li.restock && li.inventoryItemId && Number(li.quantity) > 0
              );
              for (const li of restockLines) {
                await inventoryService.reduceStock(cn.businessId, li.inventoryItemId, Number(li.quantity), s, {
                  movementType: 'adjustment_out',
                  reason: 'count_correction',
                  source: { docType: 'CreditNote', docId: cn._id },
                  notes: `Credit Note ${cn.creditNoteNumber} cancelled — restock undone`,
                  userId: user._id,
                });
              }
              cn.restockJournalEntryId = null;
            }
          } else if (cn.noteType === 'debit_note') {
            // Apply added the extra charge to the open item; cancel removes it.
            await openItemService.adjustOpenItem(
              cn.businessId,
              invoice.linkedJournalEntryId || invoice.arJournalId,
              -creditBase,
              { session: s }
            );
          }
        }
      }

      cn.state = 'cancelled';
      cn.lastModifiedBy = user._id;
      await cn.save({ session: s });
    });
    return cn;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Read
  // ───────────────────────────────────────────────────────────────────────────

  async getById(id, businessId) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, 'Invalid credit note id');
    }
    const q = { _id: id };
    if (businessId) q.businessId = businessId;
    const cn = await CreditNote.findOne(q);
    if (!cn) throw new ApiError(404, 'Credit note not found');
    return cn;
  }

  async listByInvoice(invoiceId, businessId) {
    return CreditNote.find({
      invoiceId,
      businessId,
      isArchived: { $ne: true },
    }).sort({ createdAt: -1 });
  }

  async list(businessId, filters = {}, pagination = {}) {
    const { page = 1, limit = 25 } = pagination;
    const q = { businessId, isArchived: { $ne: true } };
    if (filters.state) q.state = filters.state;
    if (filters.invoiceId) q.invoiceId = filters.invoiceId;
    if (filters.noteType) q.noteType = filters.noteType;
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      CreditNote.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit),
      CreditNote.countDocuments(q),
    ]);
    return { data, total, page, limit };
  }

  async softDelete(id, user, ipAddress) {
    const cn = await this._loadOrThrow(id, user?.businessId);
    if (cn.isArchived) return cn;
    // If applied, reverse first
    if (cn.state === 'applied') {
      await this.cancel(id, user, 'Archived', ipAddress);
    }
    cn.isArchived = true;
    cn.archivedAt = new Date();
    cn.archivedBy = user._id;
    await cn.save();
    return cn;
  }
}

module.exports = new CreditNoteService();

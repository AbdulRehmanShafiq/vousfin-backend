// services/vendorCredit.service.js
//
// Phase 3.1 — Vendor Credit domain service.
//
// A Vendor Credit represents money owed TO US by a vendor.
// Common flows:
//   1. Goods returned  → GRN discrepancy resolved as "returned_to_vendor"
//                        → VendorCredit created with reason=goods_returned
//   2. Price dispute   → AP clerk opens credit manually with reason=price_adjustment
//   3. Overpayment     → Finance creates credit with reason=overpayment
//
// The credit reduces the AP balance when applied to an open Bill.
// The pre-save hook auto-manages state (open → partially_applied → fully_applied).
//
const mongoose = require('mongoose');
const VendorCredit = require('../models/VendorCredit.model');
const Bill = require('../models/Bill.model');
const ChartOfAccount = require('../models/ChartOfAccount.model');
const vendorRepository = require('../repositories/vendor.repository');
const partyBalanceService = require('./partyBalance.service');     // ERP Step 4 — centralized AP balance
const openItemService = require('./openItem.service');              // audit F3 — recognition-JE open-item sync
const { toBaseAmount } = require('../utils/currency.util');          // audit F2 — ledger is base currency
const { postBalancedJournal } = require('./ledgerPosting.service'); // ERP Step 4 — JE + running-balance sync
const { withTransaction } = require('../utils/withTransaction');    // audit A9 — atomic multi-write
const auditService = require('./audit.service');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const {
  VENDOR_CREDIT_STATES,
  AUDIT_ACTIONS,
  ENTITY_TYPES,
  TRANSACTION_TYPES,
  TRANSACTION_SOURCES,
  JOURNAL_STATUS,
} = require('../config/constants');

class VendorCreditService {
  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  async _loadOrThrow(id, businessId = null) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid vendor credit id');
    // R-05: tenant scope when provided
    const vc = businessId
      ? await VendorCredit.findOne({ _id: id, businessId })
      : await VendorCredit.findById(id);
    if (!vc) throw new ApiError(404, 'Vendor credit not found');
    if (vc.isArchived) throw new ApiError(410, 'Vendor credit has been archived');
    return vc;
  }

  async _nextCreditNumber(businessId) {
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const prefix = `VC-${ym}-`;
    const last = await VendorCredit.findOne(
      { businessId, creditNumber: { $regex: `^${prefix}` } },
      { creditNumber: 1 }
    ).sort({ creditNumber: -1 }).lean();
    const seq = last
      ? parseInt(last.creditNumber.slice(prefix.length), 10) + 1
      : 1;
    return `${prefix}${String(seq).padStart(5, '0')}`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Creation
  // ─────────────────────────────────────────────────────────────────────────

  async create(data, user, ipAddress) {
    if (!data.businessId || !data.vendorId || !data.amount || !data.creditDate || !data.reason) {
      throw new ApiError(400, 'create requires: businessId, vendorId, amount, creditDate, reason');
    }
    if (data.amount <= 0) {
      throw new ApiError(400, 'Vendor credit amount must be greater than zero');
    }

    const creditNumber = data.creditNumber || await this._nextCreditNumber(data.businessId);

    // Inventory Engine Phase 3 (INV-2) — physical goods going back to the vendor.
    const returnItems = Array.isArray(data.returnItems)
      ? data.returnItems.filter((ri) => ri && ri.inventoryItemId && Number(ri.quantity) > 0)
      : [];

    const vc = new VendorCredit({
      businessId:        data.businessId,
      creditNumber,
      vendorId:          data.vendorId,
      sourceBillId:      data.sourceBillId  || null,
      sourceGrnId:       data.sourceGrnId   || null,
      creditDate:        data.creditDate,
      currencyCode:      data.currencyCode  || 'PKR',
      exchangeRate:      data.exchangeRate  || 1,
      amount:            data.amount,
      remainingAmount:   data.amount, // will be normalised by pre-save hook
      reason:            data.reason,
      reasonDescription: data.reasonDescription || null,
      notes:             data.notes || null,
      tags:              data.tags  || [],
      returnItems,
      state:             VENDOR_CREDIT_STATES.OPEN,
      createdBy:         user._id,
      lastModifiedBy:    user._id,
    });

    if (returnItems.length === 0) {
      await vc.save();
    } else {
      // Goods return: the stock leaves NOW, in one atomic unit with the credit.
      //   DR 1156 Vendor Credit Clearing (credit amount, base)
      //   CR 1150 Inventory              (cost of the goods, FIFO/WAC aware)
      //   ± the price difference: CR Discount Received (4180/4100) when the
      //     vendor credits more than cost, DR Inventory Write-off (6495) when less.
      // Applications later clear 1156 (see postCreditApplicationJournal), so AP
      // is only relieved when the credit is actually netted against a bill.
      const inventoryService = require('./inventory.service');
      const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

      await withTransaction(async (s) => {
        await vc.save({ session: s });

        const [clearingAcct, { inventoryAccountId }] = await Promise.all([
          ChartOfAccount.findOne({ businessId: data.businessId, accountCode: '1156' }).lean(),
          inventoryService.resolveCostAccounts(data.businessId),
        ]);
        if (!clearingAcct || !inventoryAccountId) {
          throw new ApiError(400,
            'Cannot record this goods return: your chart of accounts is missing the Vendor Credit Clearing (1156) or Inventory (1150) account. Open Chart of Accounts once to add the defaults, then try again.');
        }

        let costValue = 0;
        for (const ri of vc.returnItems) {
          const res = await inventoryService.reduceStock(
            data.businessId, ri.inventoryItemId, Number(ri.quantity), s, {
              movementType: 'purchase_return',
              source: { docType: 'VendorCredit', docId: vc._id },
              notes: `Returned to vendor — ${vc.creditNumber}`,
              userId: user._id,
            }
          );
          ri.unitCostAtReturn = res.unitCostUsed;
          costValue = r2(costValue + (res.cogsAmount || 0));
        }

        const creditBase = toBaseAmount(vc.amount, Number(vc.exchangeRate) > 0 ? Number(vc.exchangeRate) : 1);
        const journalLines = [
          { type: 'debit',  accountId: clearingAcct._id,   amount: creditBase, description: 'Vendor credit for returned goods' },
          { type: 'credit', accountId: inventoryAccountId, amount: costValue,  description: 'Goods returned to vendor' },
        ];
        const diff = r2(creditBase - costValue);
        if (diff >= 0.01) {
          const gainAcct = await ChartOfAccount.findOne({
            businessId: data.businessId, accountCode: { $in: ['4180', '4100', '4000'] },
          }).lean();
          if (!gainAcct) throw new ApiError(400, 'Cannot record this goods return: a Discount Received / Other Income account (4180/4100) is not set up.');
          journalLines.push({ type: 'credit', accountId: gainAcct._id, amount: diff, description: 'Credited above cost' });
        } else if (diff <= -0.01) {
          const lossAcct = await ChartOfAccount.findOne({
            businessId: data.businessId, accountCode: '6495',
          }).lean();
          if (!lossAcct) throw new ApiError(400, 'Cannot record this goods return: the Inventory Write-off (6495) account is not set up.');
          journalLines.push({ type: 'debit', accountId: lossAcct._id, amount: Math.abs(diff), description: 'Credited below cost' });
        }

        const je = await postBalancedJournal({
          businessId:        data.businessId,
          transactionDate:   vc.creditDate || new Date(),
          description:       `Goods returned to vendor — ${vc.creditNumber}`,
          transactionType:   TRANSACTION_TYPES.JOURNAL_ENTRY,
          amount:            creditBase,
          debitAccountId:    clearingAcct._id,
          creditAccountId:   inventoryAccountId,
          journalLines,
          status:            JOURNAL_STATUS.POSTED,
          transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
          vendorId:          vc.vendorId || null,
          currencyCode:      vc.currencyCode || 'PKR',
          exchangeRate:      Number(vc.exchangeRate) > 0 ? Number(vc.exchangeRate) : 1,
          createdBy:         user._id,
          lastModifiedBy:    user._id,
        }, { session: s });

        vc.inventoryJournalId = je._id;
        await vc.save({ session: s });
      });
    }

    try {
      await auditService.logCreate(
        ENTITY_TYPES.VENDOR_CREDIT,
        vc._id,
        vc.businessId,
        user._id,
        vc.toObject(),
        ipAddress
      );
    } catch (e) {
      // best-effort: audit-log write is observability only; the vendor credit document was already persisted.
      logger.warn(`[vc] audit logCreate failed: ${e.message}`);
    }
    return vc;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Apply credit to a bill
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Applies a portion (or all) of a vendor credit against an open bill.
   *
   * @param {string} vcId         — VendorCredit._id
   * @param {string} billId       — Bill._id to apply against
   * @param {number} amount       — Amount to apply (must be <= remainingAmount)
   * @param {Object} user
   * @param {string} [notes]      — Optional notes for this application
   * @param {string} [ipAddress]
   */
  async applyToBill(vcId, billId, amount, user, notes, ipAddress) {
    const vc = await this._loadOrThrow(vcId, user?.businessId);
    if (vc.state === VENDOR_CREDIT_STATES.CANCELLED) {
      throw new ApiError(409, 'Cannot apply a cancelled vendor credit');
    }
    if (vc.state === VENDOR_CREDIT_STATES.FULLY_APPLIED) {
      throw new ApiError(409, 'This vendor credit has already been fully applied');
    }
    if (!amount || amount <= 0) {
      throw new ApiError(400, 'Applied amount must be greater than zero');
    }
    const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
    if (r2(amount) > r2(vc.remainingAmount)) {
      throw new ApiError(
        400,
        `Applied amount ${amount} exceeds remaining credit balance ${vc.remainingAmount}`
      );
    }

    // Validate bill
    if (!mongoose.Types.ObjectId.isValid(billId)) throw new ApiError(400, 'Invalid bill id');
    const bill = await Bill.findOne({ _id: billId, businessId: vc.businessId });
    if (!bill) throw new ApiError(404, 'Bill not found');
    if (!['draft', 'awaiting_approval', 'approved', 'scheduled', 'overdue'].includes(bill.state)) {
      throw new ApiError(409, `Cannot apply credit to bill in state "${bill.state}"`);
    }
    // The credit-side check above guarantees amount <= the credit's remaining, but
    // not that the BILL owes that much. Applying more than the bill's outstanding
    // would push paidAmount above the bill total and over-reduce Accounts Payable
    // (a refund owed by the vendor must be handled as a refund, not by over-paying
    // an unrelated bill). Cap each application at what the bill still owes.
    const billOutstanding = r2(bill.remainingBalance != null
      ? bill.remainingBalance
      : (bill.totalAmount || 0) - (bill.paidAmount || 0));
    if (r2(amount) > billOutstanding + 0.01) {
      throw new ApiError(400,
        `Applied amount ${r2(amount)} exceeds the bill's remaining balance ${billOutstanding}. Apply the credit across multiple bills or record a vendor refund for the surplus.`);
    }

    // All-or-nothing (audit A9): recording the application on the vendor credit,
    // reducing the bill's balance, and posting the DR-AP/CR-credit journal (with the
    // vendor payable adjustment) must commit together. Previously each ran as a
    // separate write and the journal sat in a swallowing try/catch, so a bill could
    // be marked paid-down with no journal and a stale vendor balance.
    await withTransaction(async (s) => {
      // Record the application on the vendor credit
      vc.appliedTransactions.push({
        billId,
        billNumber:    bill.billNumber,
        appliedAmount: r2(amount),
        appliedAt:     new Date(),
        appliedBy:     user._id,
        notes:         notes || null,
      });
      // State and remainingAmount recomputed by pre-save hook
      vc.lastModifiedBy = user._id;
      await vc.save({ session: s });

      // Reduce bill's remaining balance
      const newPaid = r2((bill.paidAmount || 0) + amount);
      bill.paidAmount = newPaid;
      bill.remainingBalance = r2(Math.max(0, bill.totalAmount - newPaid));
      bill.lastModifiedBy = user._id;
      await bill.save({ session: s });

      // Phase 3.2 — post vendor credit journal: DR AP, CR Vendor Credit
      await this.postCreditApplicationJournal(vc, bill, amount, user, s);

      // Keep the RECOGNITION JE's open item in sync (audit F3): the payment
      // engine, AP aging and the VE-6 reconcile read the JE's remainingBalance.
      // F2 — the open item is BASE currency; relieve at the bill's booking rate.
      await openItemService.adjustOpenItem(
        vc.businessId,
        bill.linkedJournalEntryId || bill.apLiabilityJournalId,
        -toBaseAmount(amount, bill.exchangeRate || vc.exchangeRate),
        { session: s }
      );
    });

    try {
      await auditService.log({
        businessId:      vc.businessId,
        entityType:      ENTITY_TYPES.VENDOR_CREDIT,
        entityId:        vc._id,
        action:          AUDIT_ACTIONS.EDITED,
        performedBy:     user._id,
        performedByName: user.fullName || user.email || 'Unknown',
        afterState:      { appliedAmount: amount, billId, remainingAmount: vc.remainingAmount },
        ipAddress,
      });
    } catch (e) {
      // best-effort: audit-log write is observability only; the credit application was already committed.
      logger.warn(`[vc] audit applyToBill failed: ${e.message}`);
    }
    return vc;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 3.2 — Vendor Credit Application Journal
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Post the journal entry when a vendor credit is applied to a bill.
   *
   * Entry:
   *   DR  Accounts Payable   (2110)  — reduces AP balance (we owe less)
   *   CR  Vendor Credit      (4180 Discount Received, or a dedicated account)
   *
   * ERP Step 4: the vendor's currentPayableBalance is decremented by the same
   * applied amount (we owe the vendor less), broadcasting VENDOR_BALANCE_CHANGED.
   *
   * If the Accounts Payable account or a suitable CR account is not found the
   * journal is skipped (non-fatal — it only affects the ledger view).
   *
   * @param {Object} vc     — VendorCredit document
   * @param {Object} bill   — Bill document (already updated)
   * @param {number} amount — Applied amount
   * @param {Object} user
   */
  async postCreditApplicationJournal(vc, bill, amount, user, session = null) {
    const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
    const businessId = vc.businessId;

    const apAccount = await ChartOfAccount.findOne({
      businessId,
      accountCode: '2110',
    }).lean();

    // CR side (Phase 3): a goods-return credit already booked its value into
    // Vendor Credit Clearing (1156) at creation — applying it must DRAIN the
    // clearing account, not book income a second time. Money-only credits
    // keep the legacy income treatment (Discount Received 4180 / fallbacks).
    const crAccount = vc.inventoryJournalId
      ? await ChartOfAccount.findOne({ businessId, accountCode: '1156' }).lean()
      : await ChartOfAccount.findOne({ businessId, accountCode: { $in: ['4180', '4100', '4000'] } }).lean();

    // Can't post without both legs → fail the application (the caller's transaction
    // rolls back) rather than silently marking the bill paid-down with no journal.
    if (!apAccount) {
      throw new ApiError(500, 'Cannot apply vendor credit: Accounts Payable (2110) account is not set up.');
    }
    if (!crAccount) {
      throw new ApiError(500, vc.inventoryJournalId
        ? 'Cannot apply vendor credit: the Vendor Credit Clearing (1156) account is not set up.'
        : 'Cannot apply vendor credit: a credit account (Discount Received 4180 / Other Income 4100) is not set up.');
    }
    if (apAccount._id.toString() === crAccount._id.toString()) {
      throw new ApiError(500, 'Cannot apply vendor credit: AP and credit accounts resolve to the same account.');
    }

    // F2 (residual) — the ledger and the vendor balance are BASE currency; the
    // credit relieves the bill's carrying value at its BOOKING rate (IAS 21).
    const bookingRate = Number(bill.exchangeRate) > 0
      ? Number(bill.exchangeRate)
      : (Number(vc.exchangeRate) > 0 ? Number(vc.exchangeRate) : 1);
    const appliedBase = toBaseAmount(amount, bookingRate);
    if (appliedBase <= 0) return;

    await postBalancedJournal({
      businessId,
      transactionDate:  new Date(),
      description:      `Vendor Credit Applied — ${vc.creditNumber} → Bill ${bill.billNumber}`,
      transactionType:  TRANSACTION_TYPES.PAYMENT_MADE,
      amount:           appliedBase,
      baseCurrencyAmount: appliedBase,
      debitAccountId:   apAccount._id,   // DR Accounts Payable
      creditAccountId:  crAccount._id,   // CR Vendor Credit / Discount Received
      status:           JOURNAL_STATUS.POSTED,
      transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
      invoiceNumber:    bill.billNumber,
      vendorId:         vc.vendorId || null,
      currencyCode:     vc.currencyCode || 'PKR',
      exchangeRate:     bookingRate,
      createdBy:        user._id,
      lastModifiedBy:   user._id,
    }, { session });

    // ERP Step 4: applying a credit reduces what we owe the vendor — mirror it
    // onto the vendor's payable balance (DR AP) and broadcast the change.
    if (vc.vendorId) {
      await partyBalanceService.adjustPayable(businessId, vc.vendorId, -appliedBase, {
        userId: user._id, reason: 'vendor_credit_applied', entityType: ENTITY_TYPES.BILL, entityId: bill._id, session,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cancel
  // ─────────────────────────────────────────────────────────────────────────

  async cancel(id, user, reason, ipAddress) {
    const vc = await this._loadOrThrow(id, user?.businessId);
    if (vc.state === VENDOR_CREDIT_STATES.FULLY_APPLIED) {
      throw new ApiError(409, 'A fully applied credit cannot be cancelled. Reverse the applications first.');
    }
    if (vc.appliedTransactions.length > 0) {
      throw new ApiError(
        409,
        'This credit has partial applications. Reverse those applications before cancelling.'
      );
    }

    // Phase 3 — a cancelled goods-return credit brings the goods BACK: reverse
    // the clearing/inventory journal and restock each line at the cost it left
    // with, atomically with the state flip.
    if (vc.inventoryJournalId) {
      const inventoryService = require('./inventory.service');
      const transactionService = require('./transaction.service');
      const jeId = vc.inventoryJournalId.toString();
      await withTransaction(async (s) => {
        await transactionService.reverseTransaction(
          jeId,
          vc.businessId.toString(),
          { reason: `Vendor credit ${vc.creditNumber} cancelled — return undone`, session: s },
          user._id,
          ipAddress,
        );
        for (const ri of (vc.returnItems || [])) {
          await inventoryService.applyPurchaseStock(
            vc.businessId, ri.inventoryItemId, Number(ri.quantity),
            Number(ri.unitCostAtReturn) || 0, {
              session: s, userId: user._id,
              movementType: 'adjustment_in',
              source: { docType: 'VendorCredit', docId: vc._id },
              notes: `Vendor credit ${vc.creditNumber} cancelled — goods back in stock`,
            }
          );
        }
        vc.inventoryJournalId = null;
        vc.state = VENDOR_CREDIT_STATES.CANCELLED;
        vc.lastModifiedBy = user._id;
        if (reason) vc.notes = vc.notes ? `${vc.notes}\nCancelled: ${reason}` : `Cancelled: ${reason}`;
        await vc.save({ session: s });
      });
      try {
        await auditService.logUpdate(
          ENTITY_TYPES.VENDOR_CREDIT, vc._id, vc.businessId, user._id,
          { state: 'open' }, { state: 'cancelled', reason }, ipAddress
        );
      } catch (e) {
        logger.warn(`[vc] audit cancel failed: ${e.message}`);
      }
      return vc;
    }

    vc.state = VENDOR_CREDIT_STATES.CANCELLED;
    vc.lastModifiedBy = user._id;
    await vc.save();
    try {
      await auditService.log({
        businessId:      vc.businessId,
        entityType:      ENTITY_TYPES.VENDOR_CREDIT,
        entityId:        vc._id,
        action:          AUDIT_ACTIONS.CANCELLED,
        performedBy:     user._id,
        performedByName: user.fullName || user.email || 'Unknown',
        afterState:      { state: VENDOR_CREDIT_STATES.CANCELLED, reason },
        ipAddress,
      });
    } catch (e) {
      // best-effort: audit-log write is observability only; the cancellation state was already persisted.
      logger.warn(`[vc] audit cancel failed: ${e.message}`);
    }
    return vc;
  }

  async softDelete(id, user, ipAddress) {
    const vc = await this._loadOrThrow(id, user?.businessId);
    if (vc.isArchived) return vc;
    vc.isArchived = true;
    vc.archivedAt = new Date();
    vc.archivedBy = user._id;
    vc.lastModifiedBy = user._id;
    await vc.save();
    try {
      await auditService.logDelete(
        ENTITY_TYPES.VENDOR_CREDIT,
        vc._id,
        vc.businessId,
        user._id,
        vc.toObject(),
        ipAddress
      );
    } catch (e) {
      // best-effort: audit-log write is observability only; the soft-delete was already committed.
      logger.warn(`[vc] audit logDelete failed: ${e.message}`);
    }
    return vc;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Read APIs
  // ─────────────────────────────────────────────────────────────────────────

  async getById(id, businessId) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid vendor credit id');
    const query = { _id: id };
    if (businessId) query.businessId = businessId;
    const vc = await VendorCredit.findOne(query)
      .populate('vendorId', 'vendorName email')
      .populate('sourceBillId', 'billNumber totalAmount')
      .populate('sourceGrnId', 'grnNumber totalReceivedValue')
      .populate('appliedTransactions.billId', 'billNumber');
    if (!vc) throw new ApiError(404, 'Vendor credit not found');
    return vc;
  }

  async list(businessId, filters = {}, pagination = {}) {
    const { page = 1, limit = 25 } = pagination;
    const q = { businessId, isArchived: { $ne: true } };
    if (filters.state)    q.state    = filters.state;
    if (filters.vendorId) q.vendorId = filters.vendorId;
    if (filters.reason)   q.reason   = filters.reason;
    if (filters.search)   q.creditNumber = { $regex: filters.search, $options: 'i' };
    if (filters.openOnly) {
      q.state = { $in: [VENDOR_CREDIT_STATES.OPEN, VENDOR_CREDIT_STATES.PARTIALLY_APPLIED] };
    }
    if (filters.startDate || filters.endDate) {
      q.creditDate = {};
      if (filters.startDate) q.creditDate.$gte = new Date(filters.startDate);
      if (filters.endDate)   q.creditDate.$lte = new Date(filters.endDate);
    }
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      VendorCredit.find(q)
        .populate('vendorId', 'vendorName')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      VendorCredit.countDocuments(q),
    ]);
    return { data, total, page, limit };
  }

  /**
   * Returns all open/partially-applied credits for a vendor so
   * the Bill editor can show available credit balance.
   */
  async getAvailableCredits(businessId, vendorId) {
    return VendorCredit.find({
      businessId,
      vendorId,
      isArchived: { $ne: true },
      state: { $in: [VENDOR_CREDIT_STATES.OPEN, VENDOR_CREDIT_STATES.PARTIALLY_APPLIED] },
    })
      .select('creditNumber amount remainingAmount reason creditDate')
      .sort({ creditDate: 1 })
      .lean();
  }
}

module.exports = new VendorCreditService();

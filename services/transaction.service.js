// services/transaction.service.js
const transactionRepository = require('../repositories/transaction.repository');
const accountRepository = require('../repositories/account.repository');
const customerRepository = require('../repositories/customer.repository');
const vendorRepository = require('../repositories/vendor.repository');
const inventoryItemRepository = require('../repositories/inventoryItem.repository');
const ChartOfAccount = require('../models/ChartOfAccount.model');
const auditService = require('./audit.service');
const { ApiError } = require('../utils/ApiError');
const { ENTITY_TYPES, TRANSACTION_TYPES, INPUT_METHODS, JOURNAL_STATUS, PAYMENT_STATUS, TRANSACTION_MODES, TRANSACTION_SOURCES } = require('../config/constants');
const logger = require('../config/logger');
const reportCache = require('../utils/reportCache');
const fxService    = require('./fx.service');
const taxEngine    = require('./taxEngine.service');   // Phase 5.4
const { businessEvents, EVENTS } = require('./businessEventEngine.service'); // ERP refactor Step 2
const partyBalanceService = require('./partyBalance.service'); // ERP refactor Step 4 — centralized AR/AP balance engine
// Phase 5.1: Period lock model (inline require to avoid circular deps)

class TransactionService {
  /**
   * Create a single journal entry (v2).
   * Supports standard entries, AR/AP (Credit Sales/Purchases), and multi-line journals.
   */
  async createTransaction(data, userId, ipAddress) {
    // 0. Phase 4 — Multi-line journal: derive primary accounts from journalLines when
    //    the caller supplies lines but omits explicit debitAccountId / creditAccountId.
    //    This lets the NL confirm flow forward the full journal line set and still satisfy
    //    the 1:1 schema fields required for backward-compatible reporting.
    if (data.journalLines?.length > 0 && (!data.debitAccountId || !data.creditAccountId)) {
      const firstDebit  = data.journalLines.find((l) => l.type === 'debit');
      const firstCredit = data.journalLines.find((l) => l.type === 'credit');
      if (!data.debitAccountId  && firstDebit)  data.debitAccountId  = firstDebit.accountId;
      if (!data.creditAccountId && firstCredit) data.creditAccountId = firstCredit.accountId;
    }

    // 1. Core Validation
    if (!data.businessId || !data.transactionDate || !data.amount || !data.debitAccountId || !data.creditAccountId) {
      throw new ApiError(400, 'Missing required transaction fields');
    }
    if (data.amount <= 0) {
      throw new ApiError(400, 'Amount must be greater than zero');
    }
    if (data.debitAccountId.toString() === data.creditAccountId.toString()) {
      throw new ApiError(400, 'Debit and credit accounts must be different');
    }

    // 2. Validate accounts belong to the business
    const debitAccount = await accountRepository.findOneByBusinessAndId(data.businessId, data.debitAccountId);
    const creditAccount = await accountRepository.findOneByBusinessAndId(data.businessId, data.creditAccountId);
    if (!debitAccount || !creditAccount) {
      throw new ApiError(400, 'Invalid account(s) for this business');
    }

    // 2b. FX fields — populate currencyCode / exchangeRate / baseCurrencyAmount when a
    //     foreign currency is specified. Falls back gracefully if no rate exists.
    let baseAmount = data.amount; // amount in base currency (PKR) used for balance updates
    if (data.currencyCode) {
      try {
        const fxFields = await fxService.prepareFxFields(
          data.amount,
          data.currencyCode,
          data.businessId,
          data.transactionDate
        );
        data.currencyCode       = fxFields.currencyCode;
        data.exchangeRate       = fxFields.exchangeRate;
        data.baseCurrencyAmount = fxFields.baseCurrencyAmount;
        // When transaction is in foreign currency, base-amount drives ledger balances
        if (fxFields.exchangeRate !== 1) {
          baseAmount = fxFields.baseCurrencyAmount;
        }
      } catch (fxErr) {
        logger.warn(`[FX] prepareFxFields failed for transaction — continuing with raw amount. ${fxErr.message}`);
      }
    }

    // 3. Auto-infer transactionType when not supplied by frontend
    if (!data.transactionType) {
      const dn = debitAccount.accountName;
      const cn = creditAccount.accountName;
      const dt = debitAccount.accountType;
      const ct = creditAccount.accountType;
      if (ct === 'Revenue') {
        data.transactionType = TRANSACTION_TYPES.INCOME;
      } else if (dt === 'Expense') {
        data.transactionType = TRANSACTION_TYPES.EXPENSE;
      } else if (dn.toLowerCase().includes('receivable') || cn.toLowerCase().includes('receivable')) {
        data.transactionType = TRANSACTION_TYPES.CREDIT_SALE;
      } else if (cn.toLowerCase().includes('payable') || dn.toLowerCase().includes('payable')) {
        data.transactionType = TRANSACTION_TYPES.CREDIT_PURCHASE;
      } else if (dt === 'Asset' && ct === 'Asset') {
        data.transactionType = TRANSACTION_TYPES.TRANSFER;
      } else if (dt === 'Asset' && (ct === 'Liability' || ct === 'Equity')) {
        data.transactionType = TRANSACTION_TYPES.OWNER_INVESTMENT;
      } else if (ct === 'Asset' && (dt === 'Liability' || dt === 'Equity')) {
        data.transactionType = TRANSACTION_TYPES.OWNER_WITHDRAWAL;
      } else {
        data.transactionType = TRANSACTION_TYPES.TRANSFER;
      }
      logger.info(`Auto-inferred transactionType: ${data.transactionType} (debit: ${dn}/${dt}, credit: ${cn}/${ct})`);
    }

    // 3c. Tax Engine (Phase 5.4) — auto-calculate GST/VAT/WHT when tax is enabled.
    //  - Completely skipped when: business has no tax enabled, or caller sets skipTax=true
    //  - If caller already provides taxAmount+taxType, we honour their values and only
    //    generate the journal lines (no recalculation)
    //  - Tax journal lines are accumulated into pendingTaxLines[] and merged later (step 7b)
    //  - taxAmountTotal / taxResult are stored on entry for audit trail
    let pendingTaxLines = [];
    let taxMeta = null;

    const skipTax = data.skipTax === true ||
                    data.entryType === 'closing' ||
                    data.entryType === 'opening_balance' ||
                    data.transactionSource === 'system_generated' ||
                    // Installment engine creates compound (3-line) journals that are already
                    // balanced.  Adding tax lines would break the DR = CR invariant.
                    data.transactionSource === TRANSACTION_SOURCES.INSTALLMENT_ENGINE;

    if (!skipTax) {
      try {
        const taxEnabled = await taxEngine.isTaxEnabled(data.businessId);

        if (taxEnabled) {
          // Phase 5.4.4: Auto-detect WHT from vendor profile when vendorId is present
          let autoWhtCategory = data.whtCategory || null;
          let autoWhtApply    = data.whtApply    || false;
          let autoWhtRate     = null;

          if (data.vendorId && !autoWhtApply) {
            try {
              const Vendor = require('../models/Vendor.model');
              const vendor = await Vendor.findOne({
                _id: data.vendorId, businessId: data.businessId,
              }, 'whtProfile').lean();

              if (vendor?.whtProfile?.enabled && vendor.whtProfile.category) {
                autoWhtCategory = vendor.whtProfile.category;
                autoWhtApply    = true;
                // Non-filer rate override: taxEngine reads isNonFiler from the schedule
                if (vendor.whtProfile.customRate != null) {
                  autoWhtRate = vendor.whtProfile.customRate;
                } else if (vendor.whtProfile.isNonFiler) {
                  // Signal to engine to use rateNonFiler — pass via overrideTaxRate = -1 sentinel
                  // The engine resolves actual non-filer rate from the schedule
                  autoWhtRate = null; // taxEngine._buildWhtLine handles isNonFiler via vendor flag
                }
                logger.info(`[WHT] Auto-applying WHT from vendor profile: ${autoWhtCategory}`);
              }
            } catch (vErr) {
              logger.warn(`[WHT] Vendor profile lookup failed: ${vErr.message}`);
            }
          }

          // Phase 5.4.5: Auto-detect reverse charge from business country + vendor country
          let autoReverseCharge = data.isReverseCharge || false;
          if (!autoReverseCharge) {
            try {
              const { config: bCfg } = await taxEngine.getBusinessTaxConfig(data.businessId);
              const businessCountry = bCfg.country || 'PK';

              // If vendor has a country set, check if RC applies
              let vendorCountry = null;
              if (data.vendorId && bCfg.reverseChargeEnabled) {
                const Vendor2 = require('../models/Vendor.model');
                const vend2 = await Vendor2.findOne({ _id: data.vendorId, businessId: data.businessId }, 'country').lean();
                vendorCountry = vend2?.country || null;
              }

              autoReverseCharge = taxEngine.shouldApplyReverseCharge({
                businessCountry,
                transactionType: data.transactionType,
                isImportedService: data.isImportedService || false,
                isReverseCharge:   data.isReverseCharge || false,
                vendorCountry,
              });
            } catch (rcErr) {
              logger.warn(`[RC] Reverse charge detection failed: ${rcErr.message}`);
            }
          }

          // If caller already set an explicit taxAmount, trust it (manual override)
          const explicitTaxAmount = (data.taxAmount && data.taxAmount > 0) ? data.taxAmount : null;

          const taxResult = await taxEngine.resolveApplicableTaxes({
            businessId:      data.businessId,
            transactionType: data.transactionType,
            amount:          baseAmount,        // always use base-currency amount
            mode:            data.taxInclusive !== false ? 'inclusive' : 'exclusive',
            overrideTaxType: data.taxType   || null,
            overrideTaxRate: autoWhtRate || data.taxRate || null,
            isReverseCharge: autoReverseCharge,
            isImportedService: data.isImportedService || false,
            whtCategory:     autoWhtCategory,
            whtApply:        autoWhtApply,
          });

          if (taxResult.taxApplied && taxResult.lines.length > 0) {
            // If explicit taxAmount was provided, override engine's calculation
            const effectiveTaxAmount = explicitTaxAmount ?? taxResult.totalTax;
            const primaryLine = taxResult.lines[0];

            // Store tax metadata on the entry
            taxMeta = {
              taxAmount:   effectiveTaxAmount,
              taxRate:     primaryLine.rate,
              taxType:     primaryLine.taxType,
              taxInclusive: data.taxInclusive !== false,
            };

            // Generate journal line descriptors
            const { lines: taxJournalDescriptors } = taxEngine.generateTaxJournalLines(
              data.transactionType,
              baseAmount,
              { ...taxResult, lines: explicitTaxAmount
                  ? taxResult.lines.map(l => ({ ...l, taxAmount: effectiveTaxAmount }))
                  : taxResult.lines,
              },
              {}
            );

            // Resolve account names → IDs for each tax journal line
            for (const desc of taxJournalDescriptors) {
              if (!desc.account) continue;
              const taxAcct = await ChartOfAccount.findOne({
                businessId: data.businessId,
                accountName: { $regex: new RegExp(`^${desc.account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
              }).lean();

              if (!taxAcct) {
                logger.warn(`[Tax] Account "${desc.account}" not found for business ${data.businessId} — skipping tax line`);
                continue;
              }

              pendingTaxLines.push({
                type:      desc.debit > 0 ? 'debit' : 'credit',
                accountId: taxAcct._id,
                amount:    desc.debit > 0 ? desc.debit : desc.credit,
                memo:      desc.memo,
              });
            }

            logger.info(`[Tax] ${taxResult.countryCode} — ${taxResult.lines.map(l => `${l.taxType} ${l.rate}% = ${l.taxAmount}`).join(', ')}`);
          }
        }
      } catch (taxErr) {
        // Non-fatal: tax engine errors must never block a transaction
        logger.warn(`[Tax] Engine error — continuing without tax. ${taxErr.message}`);
      }
    }

    // 3d. Auto-generate invoice/bill number for Sales and Purchases when not provided.
    //     Format: INV-YYYYMM-XXXXX (sales) | BILL-YYYYMM-XXXXX (purchases)
    //     This ensures every sale/purchase has a traceable reference for AR/AP aging.
    const SALE_TYPES_FOR_INV = [
      TRANSACTION_TYPES.CASH_SALE, TRANSACTION_TYPES.CREDIT_SALE,
      TRANSACTION_TYPES.INVENTORY_SALE, TRANSACTION_TYPES.PAYMENT_RECEIVED,
      TRANSACTION_TYPES.ADVANCE_FROM_CUSTOMER,
    ];
    const PURCHASE_TYPES_FOR_BILL = [
      TRANSACTION_TYPES.CASH_PURCHASE, TRANSACTION_TYPES.CREDIT_PURCHASE,
      TRANSACTION_TYPES.INVENTORY_PURCHASE, TRANSACTION_TYPES.PAYMENT_MADE,
    ];
    if (!data.invoiceNumber) {
      const txDate = data.transactionDate ? new Date(data.transactionDate) : new Date();
      const yyyymm = txDate.getFullYear().toString() +
                     String(txDate.getMonth() + 1).padStart(2, '0');
      const rand   = String(Math.floor(Math.random() * 99999) + 1).padStart(5, '0');
      if (SALE_TYPES_FOR_INV.includes(data.transactionType)) {
        data.invoiceNumber = `INV-${yyyymm}-${rand}`;
      } else if (PURCHASE_TYPES_FOR_BILL.includes(data.transactionType)) {
        data.invoiceNumber = `BILL-${yyyymm}-${rand}`;
      }
    }

    // 4. Resolve customerName / vendorName → IDs (find or auto-create)
    if (!data.customerId && data.customerName?.trim()) {
      const customer = await customerRepository.findOrCreateByName(data.businessId, data.customerName.trim());
      data.customerId = customer._id;
    }
    if (!data.vendorId && data.vendorName?.trim()) {
      const vendor = await vendorRepository.findOrCreateByName(data.businessId, data.vendorName.trim());
      data.vendorId = vendor._id;
    }

    // 4.5 Accounting Period Lock Check (Phase 5.1)
    // Skip for closing/opening_balance/adjusting entries (they bypass period locks)
    const skipPeriodCheck = [
      'closing', 'opening_balance', 'adjusting',
    ].includes(data.entryType);

    let resolvedPeriodId   = data.periodId   || null;
    let resolvedFiscalYearId = data.fiscalYearId || null;

    if (!skipPeriodCheck) {
      const AccountingPeriod = require('../models/AccountingPeriod.model');
      const period = await AccountingPeriod.findCoveringPeriod(
        data.businessId,
        data.transactionDate
      );
      if (period) {
        resolvedPeriodId = period._id;
        // Find fiscal year from the period
        if (!resolvedFiscalYearId) resolvedFiscalYearId = period.fiscalYearId;

        if (period.status === 'locked') {
          // Only allow admin override
          if (!data.adminOverride) {
            throw new ApiError(423, `Accounting period "${period.name}" is locked. Contact an administrator to override.`);
          }
          logger.warn(`Admin override used to post into locked period ${period.name} by user ${userId}`);
        } else if (period.status === 'closed') {
          if (!data.adminOverride) {
            throw new ApiError(423, `Accounting period "${period.name}" is closed. Reopen the period or use an admin override.`);
          }
          logger.warn(`Admin override used to post into closed period ${period.name} by user ${userId}`);
        }
      }
    }

    // 5. Setup v2 entry data
    const entryData = {
      ...data,
      status: JOURNAL_STATUS.POSTED,
      createdBy: userId,
      lastModifiedBy: userId,
      periodId: resolvedPeriodId,
      fiscalYearId: resolvedFiscalYearId,
      entryType: data.entryType || 'normal',
      // Phase 5.4 — persist tax metadata if tax was calculated
      ...(taxMeta ? {
        taxAmount:   taxMeta.taxAmount,
        taxRate:     taxMeta.taxRate,
        taxType:     taxMeta.taxType,
        taxInclusive:taxMeta.taxInclusive,
      } : {}),
    };

    // ── GAAP compliance: Account-pair determines AR/AP treatment ────────────────
    // Under GAAP, debiting Accounts Receivable with a Revenue credit IS a credit
    // sale — the type label ("Inventory Sale", "Income", etc.) is irrelevant.
    // Crediting Accounts Payable with an Expense/Asset debit IS a credit purchase.
    // This prevents the common mistake of choosing the wrong preset but correct accounts.
    const debitAccName  = debitAccount.accountName.toLowerCase();
    const creditAccName = creditAccount.accountName.toLowerCase();

    // AR detection: DR Accounts Receivable + CR Revenue account
    const isARSaleByAccount = debitAccName.includes('accounts receivable') &&
                              creditAccount.accountType === 'Revenue';

    // AP detection: CR Accounts Payable + DR Expense or Asset account
    // Exclude "Loan Payable", "Tax Payable", "Wages Payable", "GST Payable" etc.
    const isAPPurchaseByAccount = creditAccName.includes('accounts payable') &&
                                  (debitAccount.accountType === 'Expense' || debitAccount.accountType === 'Asset') &&
                                  !debitAccName.includes('payable'); // guard: DR AP / CR AP is impossible but safe

    // 6. Handle AR (Credit Sale) Workflow
    // Triggers when: (a) explicit Credit Sale type, OR (b) account pair identifies it as AR
    if (data.transactionType === TRANSACTION_TYPES.CREDIT_SALE || isARSaleByAccount) {
      // Normalize type so the entire AR lifecycle (stats, aging, settlement) works
      entryData.transactionType  = TRANSACTION_TYPES.CREDIT_SALE;
      entryData.paymentStatus    = PAYMENT_STATUS.UNPAID;
      entryData.remainingBalance = baseAmount; // base-currency amount for correct payment matching
      entryData.transactionMode  = TRANSACTION_MODES.CREDIT;
      if (data.customerId) {
        const customer = await customerRepository.findByBusinessAndId(data.businessId, data.customerId);
        if (customer) {
          await partyBalanceService.adjustReceivable(data.businessId, data.customerId, baseAmount, {
            userId, reason: 'credit_sale', entityType: ENTITY_TYPES.JOURNAL_ENTRY,
          });
        }
      }
    }

    // 7. Handle AP (Credit Purchase) Workflow
    // Triggers when: (a) explicit Credit Purchase type, OR (b) account pair identifies it as AP
    else if (data.transactionType === TRANSACTION_TYPES.CREDIT_PURCHASE || isAPPurchaseByAccount) {
      // Normalize type so the entire AP lifecycle works
      entryData.transactionType  = TRANSACTION_TYPES.CREDIT_PURCHASE;
      entryData.paymentStatus    = PAYMENT_STATUS.UNPAID;
      entryData.remainingBalance = baseAmount; // base-currency amount for correct payment matching
      entryData.transactionMode  = TRANSACTION_MODES.CREDIT;
      if (data.vendorId) {
        const vendor = await vendorRepository.findByBusinessAndId(data.businessId, data.vendorId);
        if (vendor) {
          await partyBalanceService.adjustPayable(data.businessId, data.vendorId, baseAmount, {
            userId, reason: 'credit_purchase', entityType: ENTITY_TYPES.JOURNAL_ENTRY,
          });
        }
      }
    }

    // 7. Inventory-touching sale — auto-generate COGS journal lines
    //
    // When caller provides inventoryItemId + inventoryQty, reduce stock and
    // append DR Cost of Goods Sold / CR Inventory lines to the compound entry.
    //
    // PHASE 2.1 fix — previously only INVENTORY_SALE triggered this. Users
    // commonly record a sale as CASH_SALE / CREDIT_SALE / INCOME with an
    // inventory item attached — those must also decrement stock and post COGS,
    // otherwise the inventory drifts away from the ledger.
    const SALE_TYPES_TRIGGERING_COGS = new Set([
      TRANSACTION_TYPES.INVENTORY_SALE,
      TRANSACTION_TYPES.CASH_SALE,
      TRANSACTION_TYPES.CREDIT_SALE,
      TRANSACTION_TYPES.INCOME,
    ]);
    if (
      SALE_TYPES_TRIGGERING_COGS.has(entryData.transactionType) &&
      data.inventoryItemId &&
      data.inventoryQty > 0
    ) {
      const item = await inventoryItemRepository.model.findOne({
        _id: data.inventoryItemId,
        businessId: data.businessId,
      });
      if (!item) throw new ApiError(404, 'Inventory item not found');
      if (item.currentStock < data.inventoryQty) {
        throw new ApiError(400, `Insufficient stock: ${item.currentStock} ${item.unit || 'units'} available`);
      }

      // Find COGS + Inventory accounts for this business
      const [cogsAcct, inventoryAcct] = await Promise.all([
        ChartOfAccount.findOne({
          businessId: data.businessId,
          $or: [
            { accountName: { $regex: /cost of goods/i } },
            { accountSubtype: 'Direct Cost' },
          ],
        }).lean(),
        ChartOfAccount.findOne({
          businessId: data.businessId,
          accountName: { $regex: /^inventory$/i },
        }).lean(),
      ]);

      if (cogsAcct && inventoryAcct) {
        const cogsAmount = Math.round(data.inventoryQty * item.unitCostPrice * 100) / 100;
        // Reduce stock via inventoryService so reorder-email side-effect fires
        // when the item crosses its reorder threshold.
        const inventoryService = require('./inventory.service');
        await inventoryService.reduceStock(data.businessId, item._id, data.inventoryQty);

        // Build compound journal lines if not already provided
        if (!entryData.journalLines || entryData.journalLines.length === 0) {
          entryData.journalLines = [
            { type: 'debit',  accountId: entryData.debitAccountId,  amount: entryData.amount },
            { type: 'credit', accountId: entryData.creditAccountId, amount: entryData.amount },
          ];
        }
        // Append the COGS pair
        entryData.journalLines.push(
          { type: 'debit',  accountId: cogsAcct._id,       amount: cogsAmount },
          { type: 'credit', accountId: inventoryAcct._id,  amount: cogsAmount }
        );
        entryData.inventoryItemId = data.inventoryItemId;
        entryData.inventoryQty    = data.inventoryQty;
        logger.info(`COGS auto-generated: ${cogsAmount} for item "${item.name}" (qty ${data.inventoryQty})`);
      } else {
        logger.warn(`COGS auto-generation skipped — COGS or Inventory account not found for business ${data.businessId}`);
      }
    }

    // 7a. Inventory-touching purchase — auto-increment stock (ERP refactor Step 3)
    //
    // The mirror image of the COGS sale block above. Previously, recording an
    // Inventory/Cash/Credit Purchase with an inventory item attached posted the
    // funding journal (Inventory ⇄ Cash/Bank/AP) but NEVER increased the physical
    // stock — inventory silently drifted below the ledger. We now route the
    // increment through inventoryService.applyPurchaseStock so weighted-average
    // cost, valuation and inventory events stay consistent.
    //
    // NOTE: applyPurchaseStock posts NO journal lines (the funding journal is
    // this very transaction), so double-entry balancing is untouched. Callers
    // that already incremented stock themselves (e.g. inventoryService.addStock)
    // pass `skipInventorySync: true` to avoid double-counting.
    const PURCHASE_TYPES_TRIGGERING_STOCK = new Set([
      TRANSACTION_TYPES.INVENTORY_PURCHASE,
      TRANSACTION_TYPES.CASH_PURCHASE,
      TRANSACTION_TYPES.CREDIT_PURCHASE,
    ]);
    if (
      !data.skipInventorySync &&
      PURCHASE_TYPES_TRIGGERING_STOCK.has(entryData.transactionType) &&
      data.inventoryItemId &&
      data.inventoryQty > 0
    ) {
      const costPerUnit = Number(data.unitCostPrice) > 0
        ? Number(data.unitCostPrice)
        : Math.round((entryData.amount / data.inventoryQty) * 100) / 100;
      const inventoryService = require('./inventory.service');
      await inventoryService.applyPurchaseStock(
        data.businessId, data.inventoryItemId, data.inventoryQty, costPerUnit, { userId }
      );
      entryData.inventoryItemId = data.inventoryItemId;
      entryData.inventoryQty    = data.inventoryQty;
      logger.info(`Stock auto-incremented: qty ${data.inventoryQty} @ ${costPerUnit} for item ${data.inventoryItemId}`);
    }

    // 7b. Merge tax journal lines + validate balance
    if (pendingTaxLines.length > 0) {
      // Ensure a baseline journalLines array exists before appending tax lines
      if (!entryData.journalLines || entryData.journalLines.length === 0) {
        entryData.journalLines = [
          { type: 'debit',  accountId: entryData.debitAccountId,  amount: baseAmount },
          { type: 'credit', accountId: entryData.creditAccountId, amount: baseAmount },
        ];
      }
      // Append each tax line
      for (const tl of pendingTaxLines) {
        entryData.journalLines.push(tl);
      }
      logger.info(`[Tax] Appended ${pendingTaxLines.length} tax journal line(s) to transaction`);
    }

    if (entryData.journalLines && entryData.journalLines.length > 0) {
      let debits = 0, credits = 0;
      for (const line of entryData.journalLines) {
        if (line.type === 'debit') debits += line.amount;
        if (line.type === 'credit') credits += line.amount;
      }
      if (Math.round(debits * 100) !== Math.round(credits * 100)) {
        throw new ApiError(400, 'Journal lines are unbalanced');
      }
    }

    // 8. Create the entry
    const transaction = await transactionRepository.createTransaction(entryData);

    // 9. Update running account balances
    if (data.journalLines && data.journalLines.length > 0) {
      // Multi-line mode: update each line (journal line amounts are always in base currency)
      for (const line of data.journalLines) {
        await this._updateAccountBalance(line.accountId, line.amount, line.type);
      }
    } else {
      // Standard 1:1 mode — use baseAmount so foreign-currency transactions post the
      // correct PKR equivalent to the ledger (not the raw foreign-currency figure)
      await this._updateAccountBalance(data.debitAccountId,  baseAmount, 'debit');
      await this._updateAccountBalance(data.creditAccountId, baseAmount, 'credit');
    }

    // 10. Audit log
    await auditService.logCreate(
      ENTITY_TYPES.JOURNAL_ENTRY,
      transaction._id,
      data.businessId,
      userId,
      transaction.toObject(),
      ipAddress
    );

    // Invalidate report cache so Balance Sheet, Income Statement, etc. reflect the new entry
    reportCache.invalidate(data.businessId.toString());

    // ── Phase 1 dual-write: mirror Credit Sale / Inventory Sale → Invoice ────
    //                         mirror Credit Purchase / Inventory Purchase → Bill
    // Non-fatal: any failure is logged but the ledger entry is preserved.
    try {
      await this._mirrorInvoiceOrBill(transaction, userId, ipAddress);
    } catch (mirrorErr) {
      logger.warn(`[invoice/bill] dual-write mirror failed (non-fatal): ${mirrorErr.message}`);
    }

    logger.info(`Transaction created: ${transaction._id} by user ${userId}`);

    // ── ERP refactor Step 2 — publish to the central event engine ───────────
    // Fire-and-forget: subscribers (Steps 3–9: inventory valuation, AR/AP aging,
    // dashboard/analytics cache warming, unified audit, forecasting feed) react
    // downstream. Handler errors are isolated by the engine and can NEVER roll
    // back or unbalance the ledger entry created above.
    businessEvents.emit(EVENTS.TRANSACTION_CREATED, {
      businessId:      data.businessId,
      userId,
      entityType:      'journal_entry',
      entityId:        transaction._id,
      transactionType: transaction.transactionType,
      amount:          transaction.amount,
      inventoryItemId: data.inventoryItemId || null,
      inventoryQty:    data.inventoryQty || null,
      customerId:      transaction.customerId || null,
      vendorId:        transaction.vendorId || null,
      after:           transaction.toObject ? transaction.toObject() : transaction,
    });

    return transaction;
  }

  /**
   * Phase 1 — Dual-write helper.  Given a newly-created JournalEntry, mirror it
   * into the Invoice or Bill domain collection so the new AR/AP workflow has a
   * first-class document to track.  Backward-compatible: existing API callers
   * see no behavioural change beyond an extra row in invoices/bills.
   *
   * Lazy-required to avoid a require-time circular import
   *   (transaction.service → invoice.service → ... → transaction.service).
   */
  async _mirrorInvoiceOrBill(je, userId, ipAddress) {
    if (!je || !je.invoiceNumber) return;
    const SALE_TYPES = [
      TRANSACTION_TYPES.CREDIT_SALE,
      TRANSACTION_TYPES.INVENTORY_SALE,
    ];
    const PURCHASE_TYPES = [
      TRANSACTION_TYPES.CREDIT_PURCHASE,
      TRANSACTION_TYPES.INVENTORY_PURCHASE,
    ];
    const isSale     = SALE_TYPES.includes(je.transactionType);
    const isPurchase = PURCHASE_TYPES.includes(je.transactionType);
    if (!isSale && !isPurchase) return;

    // Build a minimal "user" record for audit attribution.  We don't load the
    // full User document on every transaction to keep latency low — only id +
    // displayName are needed by audit/state-change paths.
    const userStub = { _id: userId, fullName: 'System', email: null };

    if (isSale) {
      const invoiceService = require('./invoice.service');
      await invoiceService.syncFromJournalEntry(je, userStub, ipAddress);
    } else if (isPurchase) {
      const billService = require('./bill.service');
      await billService.syncFromJournalEntry(je, userStub, ipAddress);
    }
  }

  /**
   * Record a partial or full payment against a parent transaction (Settlement Engine).
   */
  async recordPartialPayment(parentTransactionId, businessId, paymentData, userId, ipAddress) {
    // 1. Validate Parent
    const parent = await transactionRepository.findByIdWithDetails(parentTransactionId, businessId);
    if (!parent) throw new ApiError(404, 'Parent transaction not found');
    if (parent.status === JOURNAL_STATUS.REVERSED) throw new ApiError(400, 'Cannot pay a reversed transaction');

    // Distinguish three states clearly so the user gets a precise error:
    //   remainingBalance === null  → this is a cash/non-AR/non-AP entry; payment doesn't apply
    //   remainingBalance === 0     → balance has been fully paid
    //   remainingBalance > 0       → outstanding balance exists, proceed
    if (parent.remainingBalance === null || parent.remainingBalance === undefined) {
      throw new ApiError(
        400,
        'This transaction does not track an outstanding balance (cash sales / cash expenses do not accept payments). ' +
        'Only Credit Sales, Credit Purchases, and Installment plans accept partial payments.'
      );
    }
    if (parent.remainingBalance === 0) {
      throw new ApiError(400, 'Transaction is already fully paid');
    }

    // 2. Validate Payment Amount
    if (paymentData.amount <= 0) throw new ApiError(400, 'Payment amount must be greater than zero');
    if (paymentData.amount > parent.remainingBalance) {
      throw new ApiError(400, `Payment amount (${paymentData.amount}) cannot exceed remaining balance (${parent.remainingBalance})`);
    }

    // 3. Determine transaction type based on parent
    let isReceivable = false;
    let paymentDebitAccount, paymentCreditAccount;

    if (parent.transactionType === TRANSACTION_TYPES.CREDIT_SALE) {
      isReceivable = true;
      // DR Cash/Bank (Payment Account)
      paymentDebitAccount = paymentData.paymentAccountId; 
      // CR Accounts Receivable (Parent's Debit Account)
      paymentCreditAccount = parent.debitAccountId._id; 
    } else if (parent.transactionType === TRANSACTION_TYPES.CREDIT_PURCHASE) {
      isReceivable = false;
      // DR Accounts Payable (Parent's Credit Account)
      paymentDebitAccount = parent.creditAccountId._id;
      // CR Cash/Bank (Payment Account)
      paymentCreditAccount = paymentData.paymentAccountId;
    } else {
      throw new ApiError(400, 'Parent transaction must be a Credit Sale or Credit Purchase');
    }

    // 4. Create the payment transaction (Child)
    const childData = {
      businessId,
      transactionDate: paymentData.transactionDate || new Date(),
      description: paymentData.description || `Payment for ${parent.transactionReference || 'Transaction'}`,
      transactionType: isReceivable ? TRANSACTION_TYPES.PAYMENT_RECEIVED : TRANSACTION_TYPES.PAYMENT_MADE,
      transactionMode: TRANSACTION_MODES.PARTIAL_SETTLEMENT,
      amount: paymentData.amount,
      debitAccountId: paymentDebitAccount,
      creditAccountId: paymentCreditAccount,
      parentTransactionId: parent._id,
      inputMethod: INPUT_METHODS.FORM,
      transactionReference: paymentData.reference || null,
      customerId: parent.customerId ? parent.customerId._id : null,
      vendorId: parent.vendorId ? parent.vendorId._id : null,
    };

    const childTx = await this.createTransaction(childData, userId, ipAddress);

    // 5. Update Parent
    const newRemainingBalance = parent.remainingBalance - paymentData.amount;
    const newPartiallyPaidAmount = (parent.partiallyPaidAmount || 0) + paymentData.amount;
    let newPaymentStatus = PAYMENT_STATUS.PARTIALLY_PAID;
    
    if (newRemainingBalance === 0) {
      newPaymentStatus = PAYMENT_STATUS.PAID;
    } else if (parent.dueDate && new Date() > parent.dueDate) {
      newPaymentStatus = PAYMENT_STATUS.OVERDUE;
    }

    const parentUpdate = {
      remainingBalance: newRemainingBalance,
      partiallyPaidAmount: newPartiallyPaidAmount,
      paymentStatus: newPaymentStatus,
      status: newRemainingBalance === 0 ? JOURNAL_STATUS.SETTLED : JOURNAL_STATUS.PARTIALLY_SETTLED,
      $push: { 
        relatedTransactions: childTx._id,
        settlements: {
          transactionId: childTx._id,
          amount: paymentData.amount,
          date: childData.transactionDate
        }
      }
    };

    await transactionRepository.updateTransaction(parent._id, businessId, parentUpdate);

    // 6. Update Customer/Vendor balances (centralized — emits *_BALANCE_CHANGED)
    if (isReceivable && parent.customerId) {
      await partyBalanceService.adjustReceivable(businessId, parent.customerId._id, -paymentData.amount, {
        userId, reason: 'payment_received', entityType: ENTITY_TYPES.JOURNAL_ENTRY, entityId: childTx._id,
      });
    } else if (!isReceivable && parent.vendorId) {
      await partyBalanceService.adjustPayable(businessId, parent.vendorId._id, -paymentData.amount, {
        userId, reason: 'payment_made', entityType: ENTITY_TYPES.JOURNAL_ENTRY, entityId: childTx._id,
      });
    }

    // 7. AR/AP refactor M1 — broadcast PAYMENT_RECORDED so the linked Invoice/Bill
    //    document is reconciled FROM the ledger (paidAmount / remainingBalance /
    //    state). Fire-and-forget + idempotent: the JournalEntry stays the source
    //    of truth and a subscriber failure can never block or unwind the payment.
    businessEvents.emit(EVENTS.PAYMENT_RECORDED, {
      businessId:           String(businessId),
      userId,
      entityType:           ENTITY_TYPES.JOURNAL_ENTRY,
      entityId:             parent._id,
      parentJournalEntryId: parent._id,
      childTransactionId:   childTx._id,
      amount:               paymentData.amount,
      remainingBalance:     newRemainingBalance,
      paymentStatus:        newPaymentStatus,
      isReceivable,
      invoiceNumber:        parent.invoiceNumber || null,
      customerId:           parent.customerId ? (parent.customerId._id || parent.customerId) : null,
      vendorId:             parent.vendorId ? (parent.vendorId._id || parent.vendorId) : null,
    });

    return childTx;
  }

  /**
   * Helper: Update account balance based on side (debit/credit) and account normal balance.
   * @private
   */
  async _updateAccountBalance(accountId, amount, side) {
    const account = await accountRepository.findById(accountId);
    if (!account) throw new ApiError(500, `Account ${accountId} not found`);
    let delta = 0;
    if (side === 'debit') {
      // Debit entry: increases debit-normal accounts, decreases credit-normal accounts
      delta = account.normalBalance === 'Debit' ? amount : -amount;
    } else {
      // Credit entry: increases credit-normal accounts, decreases debit-normal accounts
      delta = account.normalBalance === 'Credit' ? amount : -amount;
    }

    try {
      await accountRepository.updateRunningBalance(accountId, delta);
    } catch (balanceErr) {
      // Balance update failed AFTER the journal entry was already saved.
      // Log the drift so it can be reconciled — do NOT silently swallow.
      logger.error(
        `BALANCE_DRIFT_WARNING: Failed to update runningBalance for account ${accountId} ` +
        `(delta=${delta}, side=${side}). The journal entry was saved but the balance is stale. ` +
        `Error: ${balanceErr.message}`
      );
      // Re-throw so the caller (and any wrapping transaction) can act on this.
      throw balanceErr;
    }
  }

  /**
   * Create multiple transactions in bulk (for Excel import).
   */
  /**
   * Bulk-create transactions.
   * Processes in batches of BATCH_SIZE for ~10× throughput vs pure sequential.
   * Account balance updates use MongoDB $inc (atomic) — safe for concurrent writes.
   */
  async createBulkTransactions(entriesArray, userId, ipAddress) {
    const BATCH_SIZE = 10;
    const results    = { successful: 0, failed: [] };

    for (let i = 0; i < entriesArray.length; i += BATCH_SIZE) {
      const batch = entriesArray.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.allSettled(
        batch.map(entry => this.createTransaction(entry, userId, ipAddress))
      );

      for (let j = 0; j < batchResults.length; j++) {
        const r = batchResults[j];
        if (r.status === 'fulfilled') {
          results.successful++;
        } else {
          results.failed.push({
            row:   batch[j].originalRow,
            error: r.reason?.message || 'Unknown error',
          });
        }
      }
    }

    logger.info(`Bulk import: ${results.successful} saved, ${results.failed.length} failed`);
    return results;
  }

  /**
   * Edit an existing transaction.
   */
  async editTransaction(transactionId, businessId, updateData, userId, ipAddress) {
    const original = await transactionRepository.findByIdWithDetails(transactionId, businessId);
    if (!original) throw new ApiError(404, 'Transaction not found');
    if (original.status === JOURNAL_STATUS.REVERSED) throw new ApiError(400, 'Cannot edit a reversed transaction');
    if (original.partiallyPaidAmount > 0) throw new ApiError(400, 'Cannot edit a transaction that has payments applied against it');

    // GAAP 30-day edit lock — standard accounting: posted entries become immutable
    // after 30 days; corrections must use reversals to preserve the audit trail.
    if (!updateData.adminOverride) {
      const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      const ageMs = Date.now() - new Date(original.createdAt).getTime();
      if (ageMs > THIRTY_DAYS_MS) {
        throw new ApiError(
          423,
          'Transactions older than 30 days cannot be edited. Use "Reverse" to correct accounting entries and maintain the audit trail (GAAP).'
        );
      }
    }

    // Period Lock Check — check the ORIGINAL transaction's date period
    if (!updateData.adminOverride && original.entryType === 'normal') {
      const AccountingPeriod = require('../models/AccountingPeriod.model');
      const period = await AccountingPeriod.findCoveringPeriod(businessId, original.transactionDate);
      if (period && (period.status === 'locked' || period.status === 'closed')) {
        throw new ApiError(423, `Accounting period "${period.name}" is ${period.status}. Cannot edit transactions in a ${period.status} period.`);
      }
    }

    delete updateData.businessId;

    const amountChanged = updateData.amount != null && updateData.amount !== original.amount;
    const debitChanged = updateData.debitAccountId &&
      updateData.debitAccountId.toString() !== original.debitAccountId._id.toString();
    const creditChanged = updateData.creditAccountId &&
      updateData.creditAccountId.toString() !== original.creditAccountId._id.toString();

    // Strip account IDs that haven't actually changed.
    // This prevents Mongoose's creditAccountId custom validator from running inside
    // findOneAndUpdate (runValidators:true) where `this.debitAccountId` is undefined
    // and `undefined.toString()` throws — producing a false "Validation failed" 400.
    if (!debitChanged)  delete updateData.debitAccountId;
    if (!creditChanged) delete updateData.creditAccountId;

    // Prevent changing amount on AR/AP transactions if it breaks balance logic (simplified for Phase 1)
    if (amountChanged && (original.transactionType === TRANSACTION_TYPES.CREDIT_SALE || original.transactionType === TRANSACTION_TYPES.CREDIT_PURCHASE)) {
        throw new ApiError(400, 'Cannot edit amount of a Credit Sale/Purchase directly. Please reverse and recreate.');
    }

    if (debitChanged || creditChanged || amountChanged) {
      const newDebitId = debitChanged ? updateData.debitAccountId : original.debitAccountId._id;
      const newCreditId = creditChanged ? updateData.creditAccountId : original.creditAccountId._id;
      if (newDebitId.toString() === newCreditId.toString()) {
        throw new ApiError(400, 'Debit and credit accounts must be different');
      }
      if (debitChanged) {
        const acc = await accountRepository.findOneByBusinessAndId(businessId, newDebitId);
        if (!acc) throw new ApiError(400, 'Invalid debit account');
      }
      if (creditChanged) {
        const acc = await accountRepository.findOneByBusinessAndId(businessId, newCreditId);
        if (!acc) throw new ApiError(400, 'Invalid credit account');
      }
    }

    const updated = await transactionRepository.updateTransaction(transactionId, businessId, {
      ...updateData,
      lastModifiedBy: userId,
    });
    if (!updated) throw new ApiError(404, 'Transaction not found after update');

    if (amountChanged || debitChanged || creditChanged) {
      await this._updateAccountBalance(original.debitAccountId._id, original.amount, 'debit');
      await this._updateAccountBalance(original.creditAccountId._id, original.amount, 'credit');

      const finalDebitId = debitChanged ? updateData.debitAccountId : original.debitAccountId._id;
      const finalCreditId = creditChanged ? updateData.creditAccountId : original.creditAccountId._id;
      const finalAmount = amountChanged ? updateData.amount : original.amount;

      await this._updateAccountBalance(finalDebitId, finalAmount, 'debit');
      await this._updateAccountBalance(finalCreditId, finalAmount, 'credit');
    }

    // AR/AP parent reconciliation ─────────────────────────────────────────────
    // When a child payment transaction's amount is edited (e.g. user recorded
    // a payment of 1500 but corrects it to 1000), recalculate the parent
    // AR/AP transaction's remainingBalance and paymentStatus so the outstanding
    // balance stays accurate without needing a full reversal + re-entry.
    //
    // Example: parent amount=2000, partiallyPaidAmount=1500 → remaining=500
    //   User edits child 1500→1000 → amountDiff = -500
    //   newPaid=1000, newRemaining=1000, status→PARTIALLY_PAID
    //
    // Wrapped in try/catch — reconciliation failure must not crash the edit.
    if (amountChanged && original.parentTransactionId) {
      try {
        const parentId = original.parentTransactionId._id
          ? original.parentTransactionId._id.toString()
          : original.parentTransactionId.toString();
        const parent = await transactionRepository.findByIdWithDetails(parentId, businessId);
        if (parent && parent.amount != null) {
          const amountDiff   = updateData.amount - original.amount;
          const newPaid      = Math.max(0, (parent.partiallyPaidAmount || 0) + amountDiff);
          const newRemaining = Math.max(0, (parent.remainingBalance   || 0) - amountDiff);
          const newPayStatus = newRemaining <= 0.01
            ? PAYMENT_STATUS.PAID
            : newPaid > 0
              ? PAYMENT_STATUS.PARTIALLY_PAID
              : PAYMENT_STATUS.UNPAID;
          const newJournalStatus = newRemaining <= 0.01
            ? JOURNAL_STATUS.SETTLED
            : JOURNAL_STATUS.PARTIALLY_SETTLED;
          await transactionRepository.updateTransaction(parentId, businessId, {
            partiallyPaidAmount: newPaid,
            remainingBalance:    newRemaining,
            paymentStatus:       newPayStatus,
            status:              newJournalStatus,
          });
          logger.info(
            `AR/AP parent reconciliation: parent ${parentId} updated ` +
            `(remaining ${parent.remainingBalance}→${newRemaining}, ` +
            `paid ${parent.partiallyPaidAmount}→${newPaid}) ` +
            `after child ${transactionId} amount edit`
          );
        }
      } catch (reconErr) {
        logger.warn(`AR/AP parent reconciliation failed on payment edit: ${reconErr.message}`);
      }
    }

    await auditService.logUpdate(
      ENTITY_TYPES.JOURNAL_ENTRY,
      transactionId,
      businessId,
      userId,
      original,
      updated.toObject(),
      ipAddress
    );

    reportCache.invalidate(businessId.toString());
    return updated;
  }

  /**
   * Reverse a posted transaction — GAAP-compliant dedicated reversal.
   *
   * Creates a counter-entry that negates the original, marks the original
   * status: REVERSED, and stores a back-reference in metadata.reversalId.
   * Supports both standard 1:1 entries and multi-line compound journals.
   *
   * This is the PREFERRED reversal path (separate from deleteTransaction).
   * POST /transactions/:id/reverse
   *
   * @param {string} transactionId
   * @param {string} businessId
   * @param {object} options       - { reversalDate?, reason? }
   * @param {string} userId
   * @param {string} ipAddress
   * @returns {Promise<Object>}    - The new reversal JournalEntry
   */
  async reverseTransaction(transactionId, businessId, { reversalDate, reason } = {}, userId, ipAddress) {
    // 1. Load original with populated accounts
    const original = await transactionRepository.findByIdWithDetails(transactionId, businessId);
    if (!original) throw new ApiError(404, 'Transaction not found');

    // 2. Guard clauses
    if (original.status === JOURNAL_STATUS.REVERSED) {
      throw new ApiError(400, 'This transaction has already been reversed');
    }
    if (original.partiallyPaidAmount > 0) {
      throw new ApiError(400, 'Cannot reverse a transaction that has partial payments applied. Reverse the payments first.');
    }

    // Period Lock Check for original transaction's period
    if (original.entryType === 'normal') {
      const AccountingPeriod = require('../models/AccountingPeriod.model');
      const period = await AccountingPeriod.findCoveringPeriod(businessId, original.transactionDate);
      if (period && period.status === 'locked') {
        throw new ApiError(423, `Accounting period "${period.name}" is locked. Cannot reverse transactions in a locked period.`);
      }
    }

    // 3. Build reversal entry data
    const effectiveDate = reversalDate ? new Date(reversalDate) : new Date();
    const reasonLabel   = reason ? `Reversal (${reason})` : 'Reversal';
    const reversalDesc  = `${reasonLabel}: ${original.description}`;

    const reversalData = {
      businessId,
      transactionDate:  effectiveDate,
      description:      reversalDesc,
      transactionType:  original.transactionType,
      amount:           original.amount,
      // Flip the primary 1:1 accounts (preserved for backward-compat reporting)
      debitAccountId:   original.creditAccountId._id,
      creditAccountId:  original.debitAccountId._id,
      inputMethod:      original.inputMethod,
      status:           JOURNAL_STATUS.POSTED,
      reversalOf:       original._id,
      transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
      createdBy:        userId,
      lastModifiedBy:   userId,
    };

    // Flip multi-line journal lines if the original had compound entries
    if (original.journalLines && original.journalLines.length > 0) {
      reversalData.journalLines = original.journalLines.map((line) => ({
        accountId:   line.accountId,
        type:        line.type === 'debit' ? 'credit' : 'debit',
        amount:      line.amount,
        description: line.description || '',
      }));
    }

    // 4. Persist reversal entry
    const reversal = await transactionRepository.createTransaction(reversalData);

    // 5. Update account balances
    if (reversalData.journalLines?.length > 0) {
      for (const line of reversalData.journalLines) {
        await this._updateAccountBalance(line.accountId, line.amount, line.type);
      }
    } else {
      await this._updateAccountBalance(reversal.debitAccountId,  original.amount, 'debit');
      await this._updateAccountBalance(reversal.creditAccountId, original.amount, 'credit');
    }

    // 6. Roll back customer / vendor AR/AP balances (centralized — emits *_BALANCE_CHANGED)
    if (original.transactionType === TRANSACTION_TYPES.CREDIT_SALE && original.customerId) {
      await partyBalanceService.adjustReceivable(businessId, original.customerId._id, -original.amount, {
        userId, reason: 'reversal', entityType: ENTITY_TYPES.JOURNAL_ENTRY, entityId: original._id,
      });
    } else if (original.transactionType === TRANSACTION_TYPES.CREDIT_PURCHASE && original.vendorId) {
      await partyBalanceService.adjustPayable(businessId, original.vendorId._id, -original.amount, {
        userId, reason: 'reversal', entityType: ENTITY_TYPES.JOURNAL_ENTRY, entityId: original._id,
      });
    }

    // 7. Mark original REVERSED; store forward reference to the reversal
    const updatedMeta = { ...(original.metadata || {}), reversalId: reversal._id.toString() };
    await transactionRepository.updateTransaction(transactionId, businessId, {
      status:         JOURNAL_STATUS.REVERSED,
      paymentStatus:  null,
      remainingBalance: 0,
      metadata:       updatedMeta,
    });

    // 7b. Cascade: if this transaction has a linked installment plan, cancel it
    if (original.installmentPlanId) {
      try {
        const InstallmentPlan = require('../models/InstallmentPlan.model');
        const planId = original.installmentPlanId._id || original.installmentPlanId;
        await InstallmentPlan.findOneAndUpdate(
          { _id: planId, businessId },
          { status: 'cancelled' }
        );
        logger.info(`Installment plan ${planId} cancelled (parent transaction reversed)`);
      } catch (planErr) {
        // Non-fatal — log and continue. Reversal is more important than cascade.
        logger.warn(`Could not cancel linked installment plan: ${planErr.message}`);
      }
    }

    // 8. Audit log
    await auditService.logReversal(
      ENTITY_TYPES.JOURNAL_ENTRY,
      transactionId,
      businessId,
      userId,
      original,
      { reversalId: reversal._id, reason: reason || null },
      ipAddress
    );

    reportCache.invalidate(businessId.toString());
    logger.info(`Transaction ${transactionId} reversed → reversal ${reversal._id} by user ${userId}`);
    return reversal;
  }

  /**
   * Get full audit history for a specific transaction:
   *  - The transaction document (with populated accounts)
   *  - Any reversal entry that references this transaction
   *  - Chronological audit log entries
   *
   * GET /transactions/:id/history
   */
  async getTransactionAuditHistory(transactionId, businessId) {
    const JournalEntry = require('../models/JournalEntry.model');

    const transaction = await transactionRepository.findByIdWithDetails(transactionId, businessId);
    if (!transaction) throw new ApiError(404, 'Transaction not found');

    // Find the reversal entry that points back to this transaction (if any)
    const reversal = await JournalEntry
      .findOne({ reversalOf: transactionId })
      .populate('debitAccountId',  'accountName accountType')
      .populate('creditAccountId', 'accountName accountType')
      .lean();

    // Get chronological audit trail
    const auditResult = await auditService.getAuditTrail(ENTITY_TYPES.JOURNAL_ENTRY, transactionId);

    return {
      transaction,
      reversal:   reversal || null,
      auditTrail: auditResult?.data || [],
    };
  }

  /**
   * Delete a transaction by creating a reversal entry (soft delete).
   * Also rolls back customer/vendor balances if applicable.
   */
  async deleteTransaction(transactionId, businessId, userId, ipAddress) {
    const original = await transactionRepository.findByIdWithDetails(transactionId, businessId);
    if (!original) throw new ApiError(404, 'Transaction not found');
    if (original.status === JOURNAL_STATUS.REVERSED) throw new ApiError(400, 'Transaction already reversed');
    if (original.partiallyPaidAmount > 0) throw new ApiError(400, 'Cannot reverse a transaction that has payments applied. Reverse the payments first.');

    // Create reversal entry
    const reversalData = {
      businessId,
      transactionDate: new Date(),
      description: `Reversal of: ${original.description}`,
      transactionType: original.transactionType,
      amount: original.amount,
      debitAccountId: original.creditAccountId._id,
      creditAccountId: original.debitAccountId._id,
      inputMethod: original.inputMethod,
      status: JOURNAL_STATUS.POSTED,
      reversalOf: original._id,
      createdBy: userId,
      lastModifiedBy: userId,
    };
    const reversal = await transactionRepository.createTransaction(reversalData);

    // Revert Account Balances
    await this._updateAccountBalance(reversal.debitAccountId, original.amount, 'debit');
    await this._updateAccountBalance(reversal.creditAccountId, original.amount, 'credit');

    // Revert Customer/Vendor Balances (centralized — emits *_BALANCE_CHANGED)
    if (original.transactionType === TRANSACTION_TYPES.CREDIT_SALE && original.customerId) {
        await partyBalanceService.adjustReceivable(businessId, original.customerId._id, -original.amount, {
          userId, reason: 'transaction_deleted', entityType: ENTITY_TYPES.JOURNAL_ENTRY, entityId: original._id,
        });
    } else if (original.transactionType === TRANSACTION_TYPES.CREDIT_PURCHASE && original.vendorId) {
        await partyBalanceService.adjustPayable(businessId, original.vendorId._id, -original.amount, {
          userId, reason: 'transaction_deleted', entityType: ENTITY_TYPES.JOURNAL_ENTRY, entityId: original._id,
        });
    }

    // Mark original as reversed
    await transactionRepository.updateTransaction(transactionId, businessId, { status: JOURNAL_STATUS.REVERSED, paymentStatus: null, remainingBalance: 0 });

    await auditService.logReversal(
      ENTITY_TYPES.JOURNAL_ENTRY,
      transactionId,
      businessId,
      userId,
      original,
      { reversalId: reversal._id },
      ipAddress
    );

    reportCache.invalidate(businessId.toString());
    return reversal;
  }

  /**
   * Get filtered transaction history.
   */
  async getTransactionHistory(businessId, filters, pagination) {
    return transactionRepository.findManyWithFilters(businessId, filters, pagination);
  }

  /**
   * Get single transaction by ID with details.
   */
  async getTransactionById(transactionId, businessId) {
    const transaction = await transactionRepository.findByIdWithDetails(transactionId, businessId);
    if (!transaction) throw new ApiError(404, 'Transaction not found');
    const auditTrail = await auditService.getAuditTrail(ENTITY_TYPES.JOURNAL_ENTRY, transactionId);
    return { ...transaction, auditTrail: auditTrail.data };
  }

  /**
   * Get outstanding balances (Receivables or Payables)
   */
  async getOutstandingBalances(businessId, type) {
    if (type === 'receivable') {
      return transactionRepository.getOutstandingReceivables(businessId);
    } else if (type === 'payable') {
      return transactionRepository.getOutstandingPayables(businessId);
    } else {
      throw new ApiError(400, 'Invalid outstanding balance type. Use "receivable" or "payable"');
    }
  }

  /**
   * Compute AR/AP aging buckets from a list of outstanding rows.
   *
   * Bucket definition:
   *   current  : days <= 0   (not yet due)
   *   1-30     : 1   <= days <= 30
   *   31-60    : 31  <= days <= 60
   *   61-90    : 61  <= days <= 90
   *   90+      : days > 90
   *
   * "Days" = max(daysSince(dueDate), daysSince(transactionDate)) — falls back
   * to transactionDate when dueDate isn't set.
   *
   * @param {Array<Object>} rows - Outstanding receivable/payable rows
   * @returns {Object} aging - { current, '1-30', '31-60', '61-90', '90+', total }
   */
  computeAgingBuckets(rows) {
    const buckets = {
      current: { count: 0, amount: 0 },
      '1-30':  { count: 0, amount: 0 },
      '31-60': { count: 0, amount: 0 },
      '61-90': { count: 0, amount: 0 },
      '90+':   { count: 0, amount: 0 },
      total:   { count: 0, amount: 0 },
    };
    const now = Date.now();
    for (const r of rows || []) {
      const ref = r.dueDate || r.transactionDate;
      const days = ref
        ? Math.floor((now - new Date(ref).getTime()) / (1000 * 60 * 60 * 24))
        : 0;
      const amount = Number(r.remainingBalance ?? r.amount ?? 0);
      let key;
      if (days <= 0) key = 'current';
      else if (days <= 30) key = '1-30';
      else if (days <= 60) key = '31-60';
      else if (days <= 90) key = '61-90';
      else key = '90+';
      buckets[key].count += 1;
      buckets[key].amount += amount;
      buckets.total.count += 1;
      buckets.total.amount += amount;
    }
    /* Round to 2 dp to avoid float noise */
    for (const k of Object.keys(buckets)) {
      buckets[k].amount = Math.round(buckets[k].amount * 100) / 100;
    }
    return buckets;
  }

  /**
   * Get settlement history for a parent transaction.
   */
  async getSettlementHistory(parentTransactionId, businessId) {
    return transactionRepository.findByParentTransaction(parentTransactionId, businessId);
  }

  /**
   * Repair orphaned AR/AP transactions — idempotent, GAAP-compliant data fix.
   *
   * Finds existing JournalEntries where the account pair indicates AR or AP
   * (DR Accounts Receivable + CR Revenue, or CR Accounts Payable + DR Expense/Asset)
   * but the AR/AP lifecycle fields (paymentStatus, remainingBalance) were never set
   * — typically because the wrong preset type was selected at the time of entry.
   *
   * What it does:
   *  1. Identifies the AR and AP account IDs for this business
   *  2. Finds un-repaired AR entries (debitAccountId = AR, paymentStatus = null)
   *  3. Sets paymentStatus = UNPAID, remainingBalance = amount, type = Credit Sale
   *  4. Updates the Customer.currentReceivableBalance for linked customers
   *  5. Repeats for AP entries
   *
   * Idempotency: only processes entries where paymentStatus is currently null,
   * so running it multiple times is safe.
   *
   * @param {string} businessId
   * @returns {Promise<{ arFixed: number, apFixed: number }>}
   */
  async repairOrphanedARAPTransactions(businessId) {
    const JournalEntry = require('../models/JournalEntry.model');
    const ChartOfAccount = require('../models/ChartOfAccount.model');
    const mongoose = require('mongoose');

    const validBusinessId = new mongoose.Types.ObjectId(String(businessId));

    // 1. Find AR and AP accounts for this business
    const arAccount = await ChartOfAccount.findOne({
      businessId: validBusinessId,
      accountName: { $regex: /accounts receivable/i },
    }).lean();

    const apAccount = await ChartOfAccount.findOne({
      businessId: validBusinessId,
      accountName: { $regex: /accounts payable/i },
    }).lean();

    let arFixed = 0, apFixed = 0;

    // 2. Repair orphaned AR entries
    if (arAccount) {
      const orphanedAR = await JournalEntry.find({
        businessId: validBusinessId,
        debitAccountId: arAccount._id,
        paymentStatus: null,
        status: { $in: [JOURNAL_STATUS.POSTED] },
        isArchived: { $ne: true },
      }).lean();

      for (const tx of orphanedAR) {
        await transactionRepository.updateTransaction(tx._id, businessId, {
          transactionType:  TRANSACTION_TYPES.CREDIT_SALE,
          paymentStatus:    PAYMENT_STATUS.UNPAID,
          remainingBalance: tx.amount,
          transactionMode:  TRANSACTION_MODES.CREDIT,
        });

        // Update customer running balance if linked (centralized — emits *_BALANCE_CHANGED)
        if (tx.customerId) {
          try {
            await partyBalanceService.adjustReceivable(businessId, tx.customerId, tx.amount, {
              reason: 'arap_repair', entityType: ENTITY_TYPES.JOURNAL_ENTRY, entityId: tx._id,
            });
          } catch (_) { /* customer may have been deleted */ }
        }
        arFixed++;
      }
    }

    // 3. Repair orphaned AP entries
    if (apAccount) {
      const orphanedAP = await JournalEntry.find({
        businessId: validBusinessId,
        creditAccountId: apAccount._id,
        paymentStatus: null,
        status: { $in: [JOURNAL_STATUS.POSTED] },
        isArchived: { $ne: true },
      }).lean();

      for (const tx of orphanedAP) {
        await transactionRepository.updateTransaction(tx._id, businessId, {
          transactionType:  TRANSACTION_TYPES.CREDIT_PURCHASE,
          paymentStatus:    PAYMENT_STATUS.UNPAID,
          remainingBalance: tx.amount,
          transactionMode:  TRANSACTION_MODES.CREDIT,
        });

        if (tx.vendorId) {
          try {
            await partyBalanceService.adjustPayable(businessId, tx.vendorId, tx.amount, {
              reason: 'arap_repair', entityType: ENTITY_TYPES.JOURNAL_ENTRY, entityId: tx._id,
            });
          } catch (_) { /* vendor may have been deleted */ }
        }
        apFixed++;
      }
    }

    logger.info(`AR/AP repair: fixed ${arFixed} AR + ${apFixed} AP entries for business ${businessId}`);
    reportCache.invalidate(String(businessId));
    return { arFixed, apFixed };
  }

  /**
   * Recalculate running balance for a specific account.
   */
  async recalculateAccountBalance(businessId, accountId) {
    const transactions = await transactionRepository.getByAccount(businessId, accountId, new Date(0), new Date());
    let balance = 0;
    for (const tx of transactions) {
      const isDebit = tx.debitAccountId._id.toString() === accountId;
      const account = await accountRepository.findById(accountId);
      if (isDebit) {
        balance += (account.normalBalance === 'Debit' ? tx.amount : -tx.amount);
      } else {
        balance += (account.normalBalance === 'Credit' ? tx.amount : -tx.amount);
      }
    }
    await accountRepository.updateRunningBalance(accountId, balance - (await accountRepository.findById(accountId)).runningBalance);
    return balance;
  }

  /**
   * Refresh overdue status for AP entries — mirrors refreshOverdueAR but for payables.
   * @param {string} businessId
   * @returns {Promise<{ updated: number, scanned: number }>}
   */
  async refreshOverdueAP(businessId) {
    const JournalEntry = require('../models/JournalEntry.model');
    const mongoose = require('mongoose');
    const validId = new mongoose.Types.ObjectId(String(businessId));
    const now = new Date();

    const overdueEntries = await JournalEntry.find({
      businessId: validId,
      transactionType: { $in: [TRANSACTION_TYPES.CREDIT_PURCHASE, TRANSACTION_TYPES.INVENTORY_PURCHASE] },
      paymentStatus: { $in: [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PARTIALLY_PAID] },
      dueDate: { $lt: now, $ne: null },
      remainingBalance: { $gt: 0 },
      isArchived: { $ne: true },
    }).select('_id').lean();

    if (overdueEntries.length === 0) return { scanned: 0, updated: 0 };
    const ids = overdueEntries.map(e => e._id);
    const result = await JournalEntry.updateMany(
      { _id: { $in: ids } },
      { $set: { paymentStatus: PAYMENT_STATUS.OVERDUE } }
    );
    logger.info(`AP overdue refresh: ${result.modifiedCount} entries marked overdue for business ${businessId}`);
    reportCache.invalidate(String(businessId));
    return { scanned: overdueEntries.length, updated: result.modifiedCount };
  }

  /**
   * Refresh overdue status for AR entries — marks unpaid/partial entries as OVERDUE
   * when dueDate has passed. Safe to run repeatedly (idempotent).
   *
   * @param {string} businessId
   * @returns {Promise<{ updated: number, scanned: number }>}
   */
  async refreshOverdueAR(businessId) {
    const JournalEntry = require('../models/JournalEntry.model');
    const mongoose = require('mongoose');
    const validId = new mongoose.Types.ObjectId(String(businessId));
    const now = new Date();

    // Find all unpaid/partial AR entries that have a dueDate in the past
    const overdueEntries = await JournalEntry.find({
      businessId: validId,
      paymentStatus: { $in: [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PARTIALLY_PAID] },
      dueDate: { $lt: now, $ne: null },
      remainingBalance: { $gt: 0 },
      isArchived: { $ne: true },
    }).select('_id').lean();

    if (overdueEntries.length === 0) {
      return { scanned: 0, updated: 0 };
    }

    const ids = overdueEntries.map(e => e._id);
    const result = await JournalEntry.updateMany(
      { _id: { $in: ids } },
      { $set: { paymentStatus: PAYMENT_STATUS.OVERDUE } }
    );

    logger.info(`AR overdue refresh: ${result.modifiedCount} entries marked overdue for business ${businessId}`);
    reportCache.invalidate(String(businessId));
    return { scanned: overdueEntries.length, updated: result.modifiedCount };
  }
}

module.exports = new TransactionService();
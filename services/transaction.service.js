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
const journalGenerator = require('./journalGenerator.service'); // IAS 21 realised FX on settlement
const taxEngine    = require('./taxEngine.service');   // Phase 5.4
const { businessEvents, EVENTS } = require('./businessEventEngine.service'); // ERP refactor Step 2
const partyBalanceService = require('./partyBalance.service'); // ERP refactor Step 4 — centralized AR/AP balance engine
const { withTransaction } = require('../utils/withTransaction'); // all-or-nothing multi-write saves
// Phase 5.1: Period lock model (inline require to avoid circular deps)

const _r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// 1e12 — matches the Joi cap. Beyond this, IEEE-754 doubles lose integer
// precision for currency, so any larger value is a data-entry/overflow error.
const MAX_TXN_AMOUNT = 999_999_999_999;

/**
 * Coerce an amount from ANY caller (Joi-validated UI form or a raw internal
 * caller) into a finite, positive Number, or throw a clear 400. createTransaction
 * is the single funnel for every input path, so this is the one place that can
 * guarantee a non-finite / over-precise / over-large / string amount never
 * reaches the ledger and breaks the "every entry balances exactly" invariant.
 *
 * Headline amounts are cent-rounded (a single value — always safe). Journal-LINE
 * amounts are coerced but NOT re-rounded: rounding each line independently could
 * unbalance a compound entry (tax/FX/payroll) that the caller balanced at
 * sub-cent precision, so we only guarantee they are real finite numbers.
 *
 * @param {*} value          the raw amount
 * @param {string} label     field label for the error message
 * @param {boolean} round    cent-round the result (true for headline amounts)
 */
function toFiniteAmount(value, label, round = false) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n)) throw new ApiError(400, `${label} must be a valid number`);
  if (n <= 0) throw new ApiError(400, `${label} must be greater than zero`);
  if (n > MAX_TXN_AMOUNT) throw new ApiError(400, `${label} exceeds the maximum allowed value`);
  return round ? Math.round(n * 100) / 100 : n;
}

/**
 * Pure settlement arithmetic (audit A6). Rounds to 2dp and snaps sub-cent residue
 * to a full payoff so a fractional payment can't leave an AR/AP line PARTIALLY_PAID
 * forever with floating-point dust (e.g. 0.1 + 0.2 − 0.3 = 5e-17).
 *
 * @param {number} remaining       parent.remainingBalance before this payment
 * @param {number} payment         amount paid now
 * @param {number} partiallyPaid   parent.partiallyPaidAmount before this payment
 * @returns {{ newRemaining:number, newPartiallyPaid:number, fullyPaid:boolean }}
 */
function computeSettlement(remaining, payment, partiallyPaid = 0) {
  const raw = Number(remaining) - Number(payment);
  const newRemaining = Math.abs(raw) < 0.005 ? 0 : _r2(raw);
  return {
    newRemaining,
    newPartiallyPaid: _r2((Number(partiallyPaid) || 0) + Number(payment)),
    fullyPaid: newRemaining === 0,
  };
}

class TransactionService {
  /**
   * R-03 tax-integrity guard. The tax engine is the authority for how much tax a
   * transaction carries. A client-supplied amount may only fine-tune that figure
   * within a small rounding tolerance (so the posted tax matches what the user
   * saw on screen); any amount beyond tolerance is rejected in favour of the
   * engine value, so a forged/incorrect client amount can never corrupt the tax
   * ledger or the filing.
   *
   * @param {number|null} requestedTaxAmount  client-supplied tax (or null)
   * @param {number} engineTax                the engine's authoritative tax
   * @returns {number} the tax amount to actually post
   */
  _clampTaxToEngine(requestedTaxAmount, engineTax) {
    const eng = Math.round((Number(engineTax) || 0) * 100) / 100;
    if (requestedTaxAmount == null) return eng;
    const req = Math.round((Number(requestedTaxAmount) || 0) * 100) / 100;
    const tolerance = Math.max(0.05, eng * 0.01); // 1% or 5 minor units, whichever larger
    return Math.abs(req - eng) <= tolerance ? req : eng;
  }

  /**
   * Create a single journal entry (v2).
   * Supports standard entries, AR/AP (Credit Sales/Purchases), and multi-line journals.
   */
  async createTransaction(data, userId, ipAddress, session = null) {
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

    // 0b. Input hardening — normalize & strictly validate numeric / date inputs
    //     up front, before any other guard. createTransaction is the single
    //     funnel for every input path (form, NL-confirm, installment, batch,
    //     recurring, system); Joi only guards the UI form, so non-finite,
    //     over-precise, over-large or string amounts from other callers must be
    //     caught here before they can reach and silently corrupt the ledger.
    if (data.journalLines?.length > 0) {
      let lineDebitTotal = 0;
      for (const line of data.journalLines) {
        // Normalize the line side to canonical lowercase so the balance check,
        // the ledger posting and report aggregation (all of which key on exact
        // 'debit'/'credit') agree. A wrong-case or unknown side would otherwise be
        // silently dropped — risking a no-op or mis-balanced entry.
        line.type = String(line.type ?? '').trim().toLowerCase();
        if (line.type !== 'debit' && line.type !== 'credit') {
          throw new ApiError(400, `Journal line type must be "debit" or "credit" (got "${line.type || 'empty'}")`);
        }
        if (!line.accountId) {
          throw new ApiError(400, 'Every journal line must reference an account');
        }
        line.amount = toFiniteAmount(line.amount, 'Journal line amount'); // coerce, don't re-round (keep balance)
        if (line.type === 'debit') lineDebitTotal += line.amount;
      }
      // The canonical amount of a compound entry IS its debit total — derive it
      // when the caller omitted the headline amount (e.g. NL/installment paths).
      if (data.amount === undefined || data.amount === null || data.amount === '') {
        data.amount = Math.round(lineDebitTotal * 100) / 100;
      }
    }
    if (data.amount !== undefined && data.amount !== null && data.amount !== '') {
      data.amount = toFiniteAmount(data.amount, 'Amount', true); // headline → cent-rounded
    }
    if (data.transactionDate !== undefined && data.transactionDate !== null) {
      const parsedDate = new Date(data.transactionDate);
      if (Number.isNaN(parsedDate.getTime())) {
        throw new ApiError(400, 'Transaction date is not a valid date');
      }
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

    // 1b. Idempotency: if caller provides an idempotencyKey, skip posting if already done
    if (data.idempotencyKey) {
      const JournalEntry = require('../models/JournalEntry.model');
      const existing = await JournalEntry.findOne(
        { businessId: data.businessId, 'metadata.idempotencyKey': data.idempotencyKey },
        { _id: 1 }
      ).lean();
      if (existing) {
        logger.info(`[createTransaction] idempotent skip — key ${data.idempotencyKey} already posted as ${existing._id}`);
        return JournalEntry.findById(existing._id);
      }
      // Carry the key forward so it's stored on the new JE
      data.metadata = { ...(data.metadata || {}), idempotencyKey: data.idempotencyKey };
      delete data.idempotencyKey;
    }

    // 1c. Double-submit guard — set ONLY by the UI form controller.
    // Catches double-clicks and network retries: an exact duplicate (same accounts,
    // amount, date, description) posted within the last 10 seconds is rejected.
    // Batch/Excel/NL/system paths never set this flag — imports and schedulers may
    // legitimately post identical rows.
    if (data.doubleSubmitGuard) {
      delete data.doubleSubmitGuard;
      const recentDup = await transactionRepository.findOne({
        businessId:      data.businessId,
        amount:          data.amount,
        debitAccountId:  data.debitAccountId,
        creditAccountId: data.creditAccountId,
        description:     data.description,
        transactionDate: new Date(data.transactionDate),
        createdAt:       { $gte: new Date(Date.now() - 10_000) },
      });
      if (recentDup) {
        throw new ApiError(
          409,
          'Possible duplicate: an identical transaction was recorded seconds ago. If this is intentional, wait a few seconds and submit again.'
        );
      }
    }

    // 2. Validate accounts belong to the business
    const debitAccount = await accountRepository.findOneByBusinessAndId(data.businessId, data.debitAccountId);
    const creditAccount = await accountRepository.findOneByBusinessAndId(data.businessId, data.creditAccountId);
    if (!debitAccount || !creditAccount) {
      throw new ApiError(400, 'Invalid account(s) for this business');
    }

    // 2c. Tenant isolation: validate every journal line account belongs to this business.
    // Only debitAccountId/creditAccountId are checked above; compound journalLines are not,
    // which would allow a caller to update another tenant's account balances.
    if (data.journalLines?.length > 0) {
      const lineIds = [...new Set(data.journalLines.map(l => l.accountId?.toString()).filter(Boolean))];
      const validAccounts = await accountRepository.findAllByBusinessAndIds(data.businessId, lineIds);
      const validSet = new Set(validAccounts.map(a => a._id.toString()));
      const invalid = lineIds.filter(id => !validSet.has(id));
      if (invalid.length > 0) {
        throw new ApiError(400, `Journal line account(s) do not belong to this business: ${invalid.join(', ')}`);
      }
    }

    // 2d. SRS FR-07.1 — validate cost-centre tags (entry-level + per-line). A tag is
    // optional, but if supplied it must be an active cost centre of this business.
    {
      const costCenterService = require('./costCenter.service'); // lazy — avoid load-order coupling
      const ccIds = [data.costCenterId, ...(data.journalLines || []).map(l => l.costCenterId)]
        .filter(Boolean).map(String);
      for (const ccId of [...new Set(ccIds)]) {
        await costCenterService.validateAssignable(data.businessId, ccId);
      }
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
          data.transactionDate,
          data.exchangeRate,          // honour a caller-supplied rate when none is stored for the date
          data.baseCurrencyAmount     // prevent double-conversion if caller pre-computed the base amount
        );
        data.currencyCode       = fxFields.currencyCode;
        data.exchangeRate       = fxFields.exchangeRate;
        data.baseCurrencyAmount = fxFields.baseCurrencyAmount;
        // When transaction is in foreign currency, base-amount drives ledger balances
        if (fxFields.exchangeRate !== 1) {
          baseAmount = fxFields.baseCurrencyAmount;
        }
      } catch (fxErr) {
        // F10 — fail CLOSED: posting a foreign amount at 1:1 into the base-
        // currency ledger is silent corruption. Refuse instead.
        logger.error(`[FX] prepareFxFields failed for transaction: ${fxErr.message}`);
        throw new ApiError(
          400,
          `Could not determine an exchange rate for ${data.currencyCode}. Try again in a moment, or enter the rate manually.`
        );
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

    const NON_TAXABLE_TYPES = new Set([
      TRANSACTION_TYPES.TRANSFER,
      TRANSACTION_TYPES.BANK_TRANSFER,
      TRANSACTION_TYPES.OWNER_INVESTMENT,
      TRANSACTION_TYPES.OWNER_WITHDRAWAL,
      TRANSACTION_TYPES.LOAN_DISBURSEMENT,
      TRANSACTION_TYPES.LOAN_REPAYMENT,
      TRANSACTION_TYPES.DEPRECIATION,
      TRANSACTION_TYPES.CLOSING_ENTRY,
      TRANSACTION_TYPES.OPENING_BALANCE,
      TRANSACTION_TYPES.FX_GAIN,
      TRANSACTION_TYPES.FX_LOSS,
      TRANSACTION_TYPES.FX_REVALUATION,
      TRANSACTION_TYPES.ADJUSTING_ENTRY,
    ]);

    const skipTax = data.skipTax === true ||
                    data.entryType === 'closing' ||
                    data.entryType === 'opening_balance' ||
                    data.transactionSource === 'system_generated' ||
                    // Installment engine creates compound (3-line) journals that are already
                    // balanced.  Adding tax lines would break the DR = CR invariant.
                    data.transactionSource === TRANSACTION_SOURCES.INSTALLMENT_ENGINE ||
                    // Non-taxable transaction types: financing, capital, FX, adjusting
                    NON_TAXABLE_TYPES.has(data.transactionType);

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

          // R-03: capture any client-supplied taxAmount as a *requested* figure.
          const requestedTaxAmount = (data.taxAmount && data.taxAmount > 0) ? data.taxAmount : null;

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
            // R-03 GUARD: the tax engine is authoritative. A manual override may
            // only adjust the engine's figure within a small rounding tolerance
            // (to match what the frontend displayed). Anything beyond tolerance is
            // ignored in favour of the engine value, so a bad/forged client amount
            // can never corrupt the tax ledger or the filing.
            const engineTax = Math.round((taxResult.totalTax || 0) * 100) / 100;
            const effectiveTaxAmount = this._clampTaxToEngine(requestedTaxAmount, engineTax);
            if (requestedTaxAmount != null && effectiveTaxAmount === engineTax &&
                Math.round(requestedTaxAmount * 100) / 100 !== engineTax) {
              logger.warn(`[Tax] Manual taxAmount ${requestedTaxAmount} is outside tolerance of engine value ${engineTax} — using engine value (R-03 guard).`);
            }
            // Only remap per-line amounts when we actually accepted a value that
            // differs from the engine's own calculation.
            const explicitTaxAmount = effectiveTaxAmount !== engineTax ? effectiveTaxAmount : null;
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

            // Resolve account names → IDs for each tax journal line.
            // F11 — fail CLOSED: resolution goes name → profile CODE →
            // self-heal seed (taxEngine.resolveTaxAccountId). A line that still
            // can't resolve REFUSES the posting; silently dropping it either
            // unbalanced the entry or lost the tax from the filing.
            for (const desc of taxJournalDescriptors) {
              if (!desc.account) continue;
              const taxAcctId = await taxEngine.resolveTaxAccountId(
                data.businessId, desc.account, taxResult.countryCode
              );
              if (!taxAcctId) {
                throw new ApiError(
                  400,
                  `Tax cannot be recorded: the "${desc.account}" account is missing from this business's chart of accounts. ` +
                  'Re-enable tax in settings to recreate it, then try again.'
                );
              }

              pendingTaxLines.push({
                type:      desc.debit > 0 ? 'debit' : 'credit',
                accountId: taxAcctId,
                amount:    desc.debit > 0 ? desc.debit : desc.credit,
                memo:      desc.memo,
              });
            }

            logger.info(`[Tax] ${taxResult.countryCode} — ${taxResult.lines.map(l => `${l.taxType} ${l.rate}% = ${l.taxAmount}`).join(', ')}`);
          }
        }
      } catch (taxErr) {
        // F11 — fail CLOSED. Posting a taxable transaction WITHOUT its tax
        // silently corrupts the filing; wrong filings are worse than a retry.
        if (taxErr instanceof ApiError) throw taxErr;
        logger.error(`[Tax] Engine error — refusing the posting. ${taxErr.message}`);
        throw new ApiError(
          500,
          'Tax could not be calculated for this transaction, so nothing was posted. ' +
          'Try again in a moment — or mark the entry as non-taxable if no tax applies.'
        );
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
      if (SALE_TYPES_FOR_INV.includes(data.transactionType)) {
        data.invoiceNumber = await this._generateInvoiceNumber(data.businessId, 'INV', yyyymm);
      } else if (PURCHASE_TYPES_FOR_BILL.includes(data.transactionType)) {
        data.invoiceNumber = await this._generateInvoiceNumber(data.businessId, 'BILL', yyyymm);
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

    // ── Side-effect atomicity (audit 2026-07-02 F6) ─────────────────────────
    // Party-balance and inventory WRITES must commit together with the journal
    // entry, or not at all. Steps 6/7/7a below therefore only VALIDATE and
    // queue their writes here; the persist unit (step 8+9) executes them inside
    // the same transaction, AFTER the entry inserts. A failed insert (period
    // lock, unbalanced lines, infra) then leaves no orphaned balance or stock
    // movement.
    const deferredSideEffects = [];

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
          deferredSideEffects.push((s) =>
            partyBalanceService.adjustReceivable(data.businessId, data.customerId, baseAmount, {
              userId, reason: 'credit_sale', entityType: ENTITY_TYPES.JOURNAL_ENTRY, session: s,
            })
          );
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
          deferredSideEffects.push((s) =>
            partyBalanceService.adjustPayable(data.businessId, data.vendorId, baseAmount, {
              userId, reason: 'credit_purchase', entityType: ENTITY_TYPES.JOURNAL_ENTRY, session: s,
            })
          );
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
        // when the item crosses its reorder threshold. Deferred into the persist
        // transaction (F6) so a failed insert never leaves stock reduced with no
        // sale posted.
        const inventoryService = require('./inventory.service');
        deferredSideEffects.push((s) => inventoryService.reduceStock(data.businessId, item._id, data.inventoryQty, s));

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
      // Deferred into the persist transaction (F6) — see deferredSideEffects.
      deferredSideEffects.push((s) => inventoryService.applyPurchaseStock(
        data.businessId, data.inventoryItemId, data.inventoryQty, costPerUnit, { userId, session: s }
      ));
      entryData.inventoryItemId = data.inventoryItemId;
      entryData.inventoryQty    = data.inventoryQty;
      logger.info(`Stock auto-incremented: qty ${data.inventoryQty} @ ${costPerUnit} for item ${data.inventoryItemId}`);
    }

    // 7a-2. Consented NEW inventory item — create-or-link inside the persist
    // session (ask-first happened in the clarification loop; nothing here is
    // silent). Link-instead-of-create by exact name makes a client retry
    // idempotent: it can never mint a duplicate item. The item starts at zero
    // stock/cost and applyPurchaseStock sets both, so weighted-average cost is
    // exact. The JE is stamped with the linkage in the SAME atomic unit.
    if (
      !data.skipInventorySync &&
      PURCHASE_TYPES_TRIGGERING_STOCK.has(entryData.transactionType) &&
      !data.inventoryItemId &&
      data.newInventoryItem && typeof data.newInventoryItem === 'object'
    ) {
      const ni = data.newInventoryItem;
      const niName = String(ni.name || '').trim();
      const niQty = Number(ni.quantity);
      if (!niName) throw new ApiError(400, 'The new inventory item needs a name');
      if (!Number.isFinite(niQty) || niQty <= 0) {
        throw new ApiError(400, 'The new inventory item needs a quantity greater than zero');
      }
      const niUnit = String(ni.unit || 'units').trim() || 'units';
      const niCost = Number(ni.unitCostPrice) > 0
        ? Math.round(Number(ni.unitCostPrice) * 100) / 100
        : Math.round((entryData.amount / niQty) * 100) / 100;
      const inventoryService = require('./inventory.service');
      const escaped = niName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      deferredSideEffects.push(async (s, savedEntry) => {
        let item = await inventoryItemRepository.model
          .findOne({ businessId: data.businessId, name: new RegExp(`^${escaped}$`, 'i') })
          .session(s);
        if (!item) {
          [item] = await inventoryItemRepository.model.create(
            [{ businessId: data.businessId, name: niName, unit: niUnit, unitCostPrice: 0, currentStock: 0 }],
            { session: s }
          );
          logger.info(`[createTransaction] auto-created inventory item "${niName}" (${item._id}) with user consent`);
        }
        await inventoryService.applyPurchaseStock(data.businessId, item._id, niQty, niCost, { userId, session: s });
        if (savedEntry?._id) {
          const JournalEntry = require('../models/JournalEntry.model');
          await JournalEntry.updateOne(
            { _id: savedEntry._id },
            { $set: { inventoryItemId: item._id, inventoryQty: niQty } },
            { session: s }
          );
        }
        data.inventoryItemId = item._id; // TRANSACTION_CREATED event carries the linkage
        data.inventoryQty = niQty;
      });
      delete data.newInventoryItem;
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

    // Phase 2 convergence (canonical journal lines): every entry stores its
    // journalLines so the ledger has ONE representation — always in the REPORTING
    // (base) currency. `baseAmount` equals `amount` for domestic entries and the
    // converted base amount for foreign-currency ones, so the ledger effect, the
    // statements (via EFFECTIVE_LINES_STAGE) and the cached running balance all
    // agree in the functional currency. The original foreign amount stays on the
    // top-level `amount` field for display/audit.
    if (!entryData.journalLines || entryData.journalLines.length === 0) {
      entryData.journalLines = [
        { type: 'debit',  accountId: entryData.debitAccountId,  amount: baseAmount },
        { type: 'credit', accountId: entryData.creditAccountId, amount: baseAmount },
      ];
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

    // 8 + 9. Insert the entry AND update running balances as ONE atomic unit (#10).
    // On a replica set (Atlas) the journal-entry insert and the per-account
    // running-balance updates commit together or roll back together — so the
    // ledger and the balances can never diverge if a write fails midway. On a
    // standalone dev server withTransaction transparently falls back to the
    // previous non-atomic behaviour, so nothing breaks anywhere. If the caller
    // already owns a transaction (session passed in), we join it rather than
    // nesting a new one.
    const persist = async (txnSession) => {
      const tx = await transactionRepository.createTransaction(entryData, txnSession);
      // Use entryData.journalLines (not data.journalLines) so auto-generated
      // lines — COGS on inventory sales, tax legs — are reflected in the COA
      // running balance too. Without this the COA drifts from the Balance Sheet.
      if (entryData.journalLines && entryData.journalLines.length > 0) {
        for (const line of entryData.journalLines) {
          await this._updateAccountBalance(line.accountId, line.amount, line.type, txnSession);
        }
      } else {
        // Standard 1:1 mode — baseAmount keeps foreign-currency entries posting
        // the correct base-currency equivalent to the ledger.
        await this._updateAccountBalance(data.debitAccountId,  baseAmount, 'debit',  txnSession);
        await this._updateAccountBalance(data.creditAccountId, baseAmount, 'credit', txnSession);
      }
      // F6 — party-balance / inventory writes queued by steps 6/7/7a commit in
      // the SAME unit as the entry: an insert failure above means none ran.
      // Side effects also receive the created entry (7a-2 stamps linkage on it).
      for (const sideEffect of deferredSideEffects) {
        await sideEffect(txnSession, tx);
      }
      return tx;
    };
    const transaction = session ? await persist(session) : await withTransaction(persist);

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
   * Generate a sequential invoice/bill number for a given prefix and date string.
   * Format: {prefix}-{dateStr}-{seq:05d}  e.g. INV-202506-00001
   * Sequential over random to prevent duplicate numbers.
   * @private
   */
  async _generateInvoiceNumber(businessId, prefix, dateStr) {
    // Atomic counter: findOneAndUpdate on a dedicated counters collection avoids
    // the race condition where concurrent requests both read the same "last" value
    // and generate the same invoice number → E11000 duplicate key.
    const InvoiceCounter = require('../models/InvoiceCounter.model');
    const key = `${businessId}:${prefix}:${dateStr}`;
    const doc = await InvoiceCounter.findOneAndUpdate(
      { _id: key },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    return `${prefix}-${dateStr}-${String(doc.seq).padStart(5, '0')}`;
  }

  /**
   * Record a partial or full payment against a parent transaction (Settlement Engine).
   */
  async recordPartialPayment(parentTransactionId, businessId, paymentData, userId, ipAddress, session = null) {
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

    // 2. Validate Payment Amount (the base-currency over-payment guard runs in
    //    step 3c, after the booking rate is known — audit 2026-07-02 F2).
    if (paymentData.amount <= 0) throw new ApiError(400, 'Payment amount must be greater than zero');

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

    // 3b. Realised FX (IAS 21 §28) — when the parent is a FOREIGN-currency AR/AP,
    //     settling at a rate different from the booking rate realises an exchange
    //     gain/loss on the amount settled. We only touch the rate engine when the
    //     parent actually carries a currency, so base-currency settlements (the
    //     common case) are completely unaffected.
    const settlementDate = paymentData.transactionDate || new Date();
    let fxContext = null;
    if (parent.currencyCode) {
      const baseCurrency = await fxService.getBaseCurrency(businessId);
      if (parent.currencyCode !== baseCurrency) {
        const bookingRate    = parent.exchangeRate || 1;
        const settlementRate = paymentData.exchangeRate
          || await fxService.getRate(businessId, parent.currencyCode, baseCurrency, settlementDate);
        const realised = journalGenerator.computeRealisedFx({
          isReceivable,
          foreignAmountSettled: paymentData.amount,
          bookingRate,
          settlementRate,
        });
        fxContext = { currencyCode: parent.currencyCode, bookingRate, settlementRate, realised };
      }
    }

    // 3c. ONE currency convention (audit 2026-07-02 F2): the open item
    //     (remainingBalance), partiallyPaidAmount and the party balance are all
    //     carried in BASE currency — createTransaction booked them that way.
    //     A foreign payment amount is in DOCUMENT currency, so it relieves
    //     `amount × bookingRate` of base open item (the IAS 21 carrying value);
    //     the cash leg posts at the settlement rate and the difference books as
    //     realised FX. Base-currency settlements pass through 1:1.
    const baseSettled = fxContext
      ? _r2(paymentData.amount * fxContext.bookingRate)
      : _r2(paymentData.amount);
    if (baseSettled > _r2(parent.remainingBalance)) {
      throw new ApiError(
        400,
        `Payment amount (${paymentData.amount}${fxContext ? ` ${fxContext.currencyCode} ≈ ${baseSettled}` : ''}) ` +
        `cannot exceed remaining balance (${_r2(parent.remainingBalance)})`
      );
    }

    // 4. Create the payment transaction (Child). For a foreign settlement the child
    //    is currency-aware at the SETTLEMENT rate, so its cash leg posts at the rate
    //    actually realised; the realised-FX entry below then corrects the AR/AP
    //    control account back to its booked carrying value.
    const childData = {
      businessId,
      transactionDate: settlementDate,
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
      ...(fxContext ? { currencyCode: fxContext.currencyCode, exchangeRate: fxContext.settlementRate } : {}),
    };

    // 5. Pre-compute the parent's new settled state (pure — no writes yet).
    //    computeSettlement rounds and snaps sub-cent float residue to a full payoff
    //    (audit A6) so a fractional final payment actually settles the line.
    //    All in BASE currency (F2) — baseSettled equals the raw amount for
    //    domestic settlements.
    const { newRemaining: newRemainingBalance, newPartiallyPaid: newPartiallyPaidAmount, fullyPaid } =
      computeSettlement(parent.remainingBalance, baseSettled, parent.partiallyPaidAmount || 0);
    let newPaymentStatus = PAYMENT_STATUS.PARTIALLY_PAID;
    if (fullyPaid) {
      newPaymentStatus = PAYMENT_STATUS.PAID;
    } else if (parent.dueDate && new Date() > parent.dueDate) {
      newPaymentStatus = PAYMENT_STATUS.OVERDUE;
    }

    // ── All-or-nothing settlement ────────────────────────────────────────────
    // The child settlement entry, the parent's balance/status update and the
    // party-balance update must all commit together or all roll back. Run them in
    // one transaction. If a caller already opened a transaction (passes `session`),
    // join it instead of nesting a new one.
    const runUnit = session ? (fn) => fn(session) : (fn) => withTransaction(fn);
    const childTx = await runUnit(async (s) => {
      const child = await this.createTransaction(childData, userId, ipAddress, s);

      const parentUpdate = {
        remainingBalance: newRemainingBalance,
        partiallyPaidAmount: newPartiallyPaidAmount,
        paymentStatus: newPaymentStatus,
        status: fullyPaid ? JOURNAL_STATUS.SETTLED : JOURNAL_STATUS.PARTIALLY_SETTLED,
        $push: {
          relatedTransactions: child._id,
          settlements: {
            transactionId: child._id,
            amount: paymentData.amount,
            date: childData.transactionDate,
          },
        },
      };
      // F5 — optimistic guard: only land the precomputed balances if the parent
      // still carries the remainingBalance we read. Two concurrent payments both
      // pass the over-payment check against the same opening balance; without
      // this guard both would $set the same "after" values and the document
      // would be over-settled (double cash, AR/AP driven negative).
      const guardedParent = await transactionRepository.updateTransactionGuarded(
        parent._id, businessId,
        { remainingBalance: parent.remainingBalance },
        parentUpdate, s
      );
      if (!guardedParent) {
        throw new ApiError(
          409,
          'Another payment was applied to this document at the same moment. Refresh to see the updated balance, then try again.'
        );
      }

      // Update Customer/Vendor balances (centralized — emits *_BALANCE_CHANGED).
      // Base currency (F2): unwind exactly what the booking added.
      if (isReceivable && parent.customerId) {
        await partyBalanceService.adjustReceivable(businessId, parent.customerId._id, -baseSettled, {
          userId, reason: 'payment_received', entityType: ENTITY_TYPES.JOURNAL_ENTRY, entityId: child._id, session: s,
        });
      } else if (!isReceivable && parent.vendorId) {
        await partyBalanceService.adjustPayable(businessId, parent.vendorId._id, -baseSettled, {
          userId, reason: 'payment_made', entityType: ENTITY_TYPES.JOURNAL_ENTRY, entityId: child._id, session: s,
        });
      }

      // Realised FX correction (IAS 21 §28) — same session, idempotent. Posts only
      // when the rate moved materially. The AR/AP control account is the parent's
      // receivable (debit) or payable (credit) account.
      if (fxContext && fxContext.realised.hasFx) {
        const arApAccountId = isReceivable ? parent.debitAccountId._id : parent.creditAccountId._id;
        await journalGenerator.generateRealizedFxEntry({
          businessId,
          transactionDate: settlementDate,
          description: `Realised FX on settlement — ${parent.invoiceNumber || parent.transactionReference || parent._id}`,
          fxAmount: fxContext.realised.fxAmount,
          isGain: fxContext.realised.isGain,
          isReceivable,
          arApAccountId,
          userId,
          parentId: parent._id,
          settlementId: child._id,
        }, { session: s });
      }
      return child;
    });

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
  async _updateAccountBalance(accountId, amount, side, session = null) {
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
      await accountRepository.updateRunningBalance(accountId, delta, session);
    } catch (balanceErr) {
      if (session) {
        // Inside a MongoDB transaction — withTransaction() will retry on WriteConflict,
        // so no real drift occurs. Use warn, not error, to avoid alarm spam in logs.
        logger.warn(
          `[balance-retry] Write conflict on account ${accountId} (delta=${delta}, side=${side}) — ` +
          `withTransaction will retry. Error: ${balanceErr.message}`
        );
      } else {
        // Outside any transaction — the JE was already committed and the balance
        // update failed separately. This IS a real balance drift. Needs reconciliation.
        logger.error(
          `BALANCE_DRIFT_WARNING: account ${accountId} (delta=${delta}, side=${side}) — ` +
          `JE saved without matching balance update. Manual reconciliation needed. ` +
          `Error: ${balanceErr.message}`
        );
      }
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

    const amountChanged = updateData.amount != null && Number(updateData.amount) !== original.amount;
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

    // ── Financial immutability (audit 2026-07-02 F13) ───────────────────────
    // Posted entries are financially immutable — the model layer
    // (checkImmutability) already rejects any amount/account mutation, so the
    // old "reverse old balances / apply new balances" edit path could never
    // complete (and would corrupt compound tax/COGS entries if it could: it
    // rebalanced only the top-level pair and left journalLines stale). Reject
    // up front with actionable guidance instead of a confusing mid-write 403.
    if (amountChanged || debitChanged || creditChanged) {
      throw new ApiError(
        400,
        'The amount and accounts of a posted entry cannot be changed. ' +
        'Reverse this transaction and record a corrected one — the reversal keeps your history complete.'
      );
    }

    const updated = await transactionRepository.updateTransaction(transactionId, businessId, {
      ...updateData,
      lastModifiedBy: userId,
    });
    if (!updated) throw new ApiError(404, 'Transaction not found after update');

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
  async reverseTransaction(transactionId, businessId, { reversalDate, reason, session } = {}, userId, ipAddress) {
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

    // Also check that the reversal's own date is not in a locked period
    if (original.entryType === 'normal') {
      const AccountingPeriod = require('../models/AccountingPeriod.model');
      const reversalPeriod = await AccountingPeriod.findCoveringPeriod(businessId, effectiveDate);
      if (reversalPeriod && reversalPeriod.status === 'locked') {
        throw new ApiError(
          423,
          `Reversal date falls in a locked period "${reversalPeriod.name}". Use a different reversal date or an admin override.`
        );
      }
    }

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

    // 4-7. All-or-nothing (audit A9/A3): the reversal entry, both running-balance
    // updates, the party AR/AP rollback, and marking the original REVERSED must
    // commit together or all roll back — otherwise a mid-sequence failure drifts
    // the trial balance or double-counts the position.
    // Join the caller's transaction when one is supplied (so an enclosing unit —
    // e.g. creditNote.cancel — commits the reversal together with its own writes),
    // otherwise open our own all-or-nothing transaction (legacy standalone path).
    const runUnit = session
      ? (fn) => fn(session)
      : (fn) => withTransaction(fn);
    const reversal = await runUnit(async (s) => {
      // 4. Persist reversal entry
      const rev = await transactionRepository.createTransaction(reversalData, s);

      // 5. Update account balances
      if (reversalData.journalLines?.length > 0) {
        for (const line of reversalData.journalLines) {
          await this._updateAccountBalance(line.accountId, line.amount, line.type, s);
        }
      } else {
        await this._updateAccountBalance(rev.debitAccountId,  original.amount, 'debit',  s);
        await this._updateAccountBalance(rev.creditAccountId, original.amount, 'credit', s);
      }

      // 6. Roll back customer / vendor AR/AP balances (centralized — emits *_BALANCE_CHANGED)
      if (original.transactionType === TRANSACTION_TYPES.CREDIT_SALE && original.customerId) {
        await partyBalanceService.adjustReceivable(businessId, original.customerId._id, -original.amount, {
          userId, reason: 'reversal', entityType: ENTITY_TYPES.JOURNAL_ENTRY, entityId: original._id, session: s,
        });
      } else if (original.transactionType === TRANSACTION_TYPES.CREDIT_PURCHASE && original.vendorId) {
        await partyBalanceService.adjustPayable(businessId, original.vendorId._id, -original.amount, {
          userId, reason: 'reversal', entityType: ENTITY_TYPES.JOURNAL_ENTRY, entityId: original._id, session: s,
        });
      }

      // 7. Mark original REVERSED; store forward reference to the reversal
      const updatedMeta = { ...(original.metadata || {}), reversalId: rev._id.toString() };
      await transactionRepository.updateTransaction(transactionId, businessId, {
        status:         JOURNAL_STATUS.REVERSED,
        paymentStatus:  null,
        remainingBalance: 0,
        metadata:       updatedMeta,
      }, s);

      // 7a. Settlement-child reversal (audit 2026-07-02 F4): reversing a payment
      // flips the GL legs (AR/AP control restored) — the PARENT's open item and
      // the party balance must be restored in the SAME unit, or the control
      // account, the aging report and the customer/vendor balances all diverge.
      const SETTLEMENT_CHILD_TYPES = [TRANSACTION_TYPES.PAYMENT_RECEIVED, TRANSACTION_TYPES.PAYMENT_MADE];
      if (original.parentTransactionId && SETTLEMENT_CHILD_TYPES.includes(original.transactionType)) {
        const parentId = original.parentTransactionId._id
          ? original.parentTransactionId._id.toString()
          : original.parentTransactionId.toString();
        const parent = await transactionRepository.findByIdWithDetails(parentId, businessId);
        // A parent that was itself reversed already had its position rolled back — leave it.
        if (parent && parent.status !== JOURNAL_STATUS.REVERSED) {
          // Base currency (F2): a foreign settlement relieved amount × BOOKING
          // rate of base open item, so the restore mirrors exactly that.
          const isForeignSettlement = original.currencyCode && parent.currencyCode === original.currencyCode;
          const restoredAmt = isForeignSettlement
            ? _r2(original.amount * (parent.exchangeRate || 1))
            : _r2(original.amount);
          const newRemaining = _r2((parent.remainingBalance || 0) + restoredAmt);
          const newPaid      = Math.max(0, _r2((parent.partiallyPaidAmount || 0) - restoredAmt));
          const newPaymentStatus = newPaid > 0
            ? PAYMENT_STATUS.PARTIALLY_PAID
            : (parent.dueDate && new Date() > new Date(parent.dueDate) ? PAYMENT_STATUS.OVERDUE : PAYMENT_STATUS.UNPAID);
          const newStatus = newPaid > 0 ? JOURNAL_STATUS.PARTIALLY_SETTLED : JOURNAL_STATUS.POSTED;

          await transactionRepository.updateTransaction(parentId, businessId, {
            remainingBalance:    newRemaining,
            partiallyPaidAmount: newPaid,
            paymentStatus:       newPaymentStatus,
            status:              newStatus,
            $pull: {
              settlements:         { transactionId: original._id },
              relatedTransactions: original._id,
            },
          }, s);

          if (parent.transactionType === TRANSACTION_TYPES.CREDIT_SALE && parent.customerId) {
            await partyBalanceService.adjustReceivable(
              businessId, parent.customerId._id || parent.customerId, restoredAmt,
              { userId, reason: 'payment_reversal', entityType: ENTITY_TYPES.JOURNAL_ENTRY, entityId: original._id, session: s }
            );
          } else if (parent.transactionType === TRANSACTION_TYPES.CREDIT_PURCHASE && parent.vendorId) {
            await partyBalanceService.adjustPayable(
              businessId, parent.vendorId._id || parent.vendorId, restoredAmt,
              { userId, reason: 'payment_reversal', entityType: ENTITY_TYPES.JOURNAL_ENTRY, entityId: original._id, session: s }
            );
          }
        }
      }

      // 7b. Inventory restoration (audit 2026-07-02 F8): the journal-line flip
      // above restores the GL inventory value — the PHYSICAL quantity must move
      // with it or the stock subledger drifts from the ledger forever.
      //   • Sale reversal → add the quantity back at the ORIGINAL COGS unit
      //     cost (derived from the entry's own inventory credit leg) so
      //     qty × cost matches the GL flip exactly; falls back to the item's
      //     current cost for legacy entries without journal lines.
      //   • Purchase reversal → remove the quantity through the normal costing
      //     method (WAC/FIFO). If the goods were already sold, reduceStock
      //     throws and the whole reversal rolls back — you can't un-buy stock
      //     that is gone; correct the position with an inventory adjustment.
      if (original.inventoryItemId && original.inventoryQty > 0) {
        const inventoryService = require('./inventory.service');
        const itemId = original.inventoryItemId._id || original.inventoryItemId;
        const SALE_TYPES_WITH_COGS = [
          TRANSACTION_TYPES.INVENTORY_SALE, TRANSACTION_TYPES.CASH_SALE,
          TRANSACTION_TYPES.CREDIT_SALE, TRANSACTION_TYPES.INCOME,
        ];
        const PURCHASE_TYPES_WITH_STOCK = [
          TRANSACTION_TYPES.INVENTORY_PURCHASE, TRANSACTION_TYPES.CASH_PURCHASE,
          TRANSACTION_TYPES.CREDIT_PURCHASE,
        ];
        if (SALE_TYPES_WITH_COGS.includes(original.transactionType)) {
          let costPerUnit = null;
          if (original.journalLines && original.journalLines.length > 0) {
            const invAcct = await ChartOfAccount.findOne({
              businessId, accountName: { $regex: /^inventory$/i },
            }).lean();
            const cogsLeg = invAcct && original.journalLines.find(
              (l) => l.type === 'credit' && String(l.accountId) === String(invAcct._id)
            );
            if (cogsLeg) costPerUnit = _r2(cogsLeg.amount / original.inventoryQty);
          }
          await inventoryService.applyPurchaseStock(
            businessId, itemId, original.inventoryQty, costPerUnit, { userId, session: s }
          );
        } else if (PURCHASE_TYPES_WITH_STOCK.includes(original.transactionType)) {
          await inventoryService.reduceStock(businessId, itemId, original.inventoryQty, s);
        }
      }

      return rev;
    });

    // 7c. Cascade: if this transaction has a linked installment plan, cancel it
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
    return this.reverseTransaction(
      transactionId,
      businessId,
      { reversalDate: new Date(), reason: 'Deleted by user' },
      userId,
      ipAddress
    );
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

    // 1. Find ALL AR and AP accounts for this business (covers non-standard names like
    //    "Trade Receivables", "Accounts Receivable - Trade", etc.).
    const arAccounts = await ChartOfAccount.find({
      businessId: validBusinessId,
      accountName: { $regex: /receivable/i },
    }).select('_id').lean();

    // Only match "Accounts Payable" (and variants like "Accounts Payable - Trade").
    // Deliberately excluded: "Tax Payable", "GST Payable", "WHT Payable", "Wages Payable",
    // "Loan Payable" — those are not vendor AP accounts and must not get AP lifecycle fields.
    const apAccounts = await ChartOfAccount.find({
      businessId: validBusinessId,
      accountName: { $regex: /accounts payable/i },
    }).select('_id').lean();

    const arAccountIds = arAccounts.map(a => a._id);
    const apAccountIds = apAccounts.map(a => a._id);

    let arFixed = 0, apFixed = 0;

    // 2. Repair orphaned AR entries — any posted entry that debits a receivable account
    //    but has never had its AR lifecycle fields (paymentStatus, remainingBalance) set.
    if (arAccountIds.length > 0) {
      const orphanedAR = await JournalEntry.find({
        businessId: validBusinessId,
        debitAccountId: { $in: arAccountIds },
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

    // 3. Repair orphaned AP entries — any posted entry that credits a payable account
    //    but has never had its AP lifecycle fields set.
    if (apAccountIds.length > 0) {
      const orphanedAP = await JournalEntry.find({
        businessId: validBusinessId,
        creditAccountId: { $in: apAccountIds },
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
   * Recalculate running balance for a specific account FROM THE JOURNAL.
   * Compound-aware: derives from effective lines (so an account that appears only
   * in a non-primary journalLine of a compound entry is counted), via the shared
   * ledger-integrity derivation. Sets the cached balance to the journal-derived
   * value (the journal is authoritative; the cache is what drifts).
   */
  async recalculateAccountBalance(businessId, accountId) {
    const ledgerIntegrity = require('./ledgerIntegrity.service');
    const derived = await ledgerIntegrity.accountDerivedBalance(businessId, accountId);
    const current = (await accountRepository.findById(accountId))?.runningBalance || 0;
    await accountRepository.updateRunningBalance(accountId, Math.round((derived - current) * 100) / 100);
    return derived;
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
    const result = await JournalEntry.collection.updateMany(
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
    const result = await JournalEntry.collection.updateMany(
      { _id: { $in: ids } },
      { $set: { paymentStatus: PAYMENT_STATUS.OVERDUE } }
    );

    logger.info(`AR overdue refresh: ${result.modifiedCount} entries marked overdue for business ${businessId}`);
    reportCache.invalidate(String(businessId));
    return { scanned: overdueEntries.length, updated: result.modifiedCount };
  }
}

module.exports = new TransactionService();
module.exports.computeSettlement = computeSettlement;
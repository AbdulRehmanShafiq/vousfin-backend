// services/journalGenerator.service.js
// IAS 21-compliant FX journal generator.
// Creates system-generated realized gain/loss and unrealised revaluation entries.
// Never called from user-facing request handlers directly — only from transaction.service
// and the fx-rates controller (month-end revaluation endpoint).
const JournalEntry   = require('../models/JournalEntry.model');
const ChartOfAccount = require('../models/ChartOfAccount.model');
const { applyRunningBalance, postCompoundJournal } = require('./ledgerPosting.service');
const fxService      = require('./fx.service');
const reportCache    = require('../utils/reportCache');
const logger         = require('../config/logger');
const {
  TRANSACTION_TYPES,
  JOURNAL_STATUS,
  INPUT_METHODS,
  TRANSACTION_SOURCES,
} = require('../config/constants');

/**
 * Pure: decide the debit/credit legs and gain/loss for an unrealised FX month-end
 * revaluation of a monetary item (IAS 21 §23(a)). Exported for unit testing.
 *
 *   diff = currentBaseValue − bookedBaseValue
 *   AR (asset):     diff>0 = GAIN  (DR AR / CR Unrealised);  diff<0 = LOSS (DR Unrealised / CR AR)
 *   AP (liability): diff>0 = LOSS  (DR Unrealised / CR AP);  diff<0 = GAIN (DR AP / CR Unrealised)
 *
 * The monetary account always moves in its natural direction as its base value
 * rises: AR (asset) is debited when value rises; AP (liability) is credited when
 * value rises.
 *
 * @param {{ isAR:boolean, diff:number, monetaryAccId:any, unrealisedAccId:any }} p
 * @returns {{ isGain:boolean, absAmt:number, debitId:any, creditId:any }}
 */
function buildUnrealisedFxRevaluation({ isAR, diff, monetaryAccId, unrealisedAccId }) {
  const absAmt = Math.round(Math.abs(Number(diff) || 0) * 100) / 100;
  const isGain = isAR ? diff > 0 : diff < 0;
  let debitId, creditId;
  if (diff > 0) {
    // base value rose: AR is debited (asset up); AP is credited (liability up)
    if (isAR) { debitId = monetaryAccId; creditId = unrealisedAccId; }
    else      { debitId = unrealisedAccId; creditId = monetaryAccId; }
  } else {
    // base value fell: AR is credited (asset down); AP is debited (liability down)
    if (isAR) { debitId = unrealisedAccId; creditId = monetaryAccId; }
    else      { debitId = monetaryAccId; creditId = unrealisedAccId; }
  }
  return { isGain, absAmt, debitId, creditId };
}

class JournalGeneratorService {
  // ── Helpers ──────────────────────────────────────────────────────────────────

  /** Look up the FX Gain (4140), FX Loss (6200), and Unrealised (6210) accounts. */
  async _getFxAccounts(businessId) {
    const accounts = await ChartOfAccount.find({
      businessId,
      accountCode: { $in: ['4140', '6200', '6210'] },
    }).lean();
    return {
      gain:        accounts.find(a => a.accountCode === '4140'),
      loss:        accounts.find(a => a.accountCode === '6200'),
      unrealised:  accounts.find(a => a.accountCode === '6210'),
    };
  }

  // ── Realised FX Gain / Loss ───────────────────────────────────────────────

  /**
   * Create a realised FX gain or loss journal for a settled foreign-currency
   * AR or AP position.
   *
   * IAS 21 §28: Exchange differences arising on settlement of monetary items
   * shall be recognised in profit or loss in the period in which they arise.
   *
   * Accounting entries:
   *   AR gain  : DR Accounts Receivable  /  CR FX Gain on Exchange
   *   AR loss  : DR FX Loss on Exchange  /  CR Accounts Receivable
   *   AP gain  : DR Accounts Payable     /  CR FX Gain on Exchange
   *   AP loss  : DR FX Loss on Exchange  /  CR Accounts Payable
   *
   * @param {Object} p
   * @param {string|ObjectId} p.businessId
   * @param {Date}            p.transactionDate
   * @param {string}          p.description
   * @param {number}          p.fxAmount        absolute FX difference (base currency)
   * @param {boolean}         p.isGain          true = gain, false = loss
   * @param {boolean}         p.isReceivable    true = AR, false = AP
   * @param {ObjectId}        p.arApAccountId   the AR or AP ChartOfAccount _id
   * @param {string|ObjectId} p.userId          creator user id
   * @param {ObjectId}        [p.parentId]      originating transaction id (for reference)
   * @returns {Promise<Object|null>}
   */
  async generateRealizedFxEntry({
    businessId,
    transactionDate,
    description,
    fxAmount,
    isGain,
    isReceivable,
    arApAccountId,
    userId,
    parentId,
  }) {
    if (!fxAmount || fxAmount <= 0) return null;

    const fxAccts = await this._getFxAccounts(businessId);
    const fxPnlId = isGain ? fxAccts.gain?._id : fxAccts.loss?._id;

    if (!fxPnlId) {
      logger.warn(`[FX] Gain/Loss account missing for business ${businessId} — skipping realised FX journal`);
      return null;
    }

    let debitId, creditId;
    if (isGain) {
      // Gain: monetary item account DR, FX Gain CR
      debitId  = arApAccountId;
      creditId = fxPnlId;
    } else {
      // Loss: FX Loss DR, monetary item account CR
      debitId  = fxPnlId;
      creditId = arApAccountId;
    }

    // AP: flip sides (AP is a liability, so the gain/loss polarity is reversed)
    if (!isReceivable) {
      [debitId, creditId] = [creditId, debitId];
    }

    const entry = await JournalEntry.create({
      businessId,
      transactionDate,
      description:      description || `Realised FX ${isGain ? 'Gain' : 'Loss'}`,
      transactionType:  isGain ? TRANSACTION_TYPES.FX_GAIN : TRANSACTION_TYPES.FX_LOSS,
      amount:           fxAmount,
      baseCurrencyAmount: fxAmount,
      exchangeRate:     1,
      debitAccountId:   debitId,
      creditAccountId:  creditId,
      inputMethod:      INPUT_METHODS.FORM,
      status:           JOURNAL_STATUS.POSTED,
      transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
      entryType:        'adjusting',
      createdBy:        userId,
      lastModifiedBy:   userId,
      ...(parentId ? { metadata: { fxSourceTransactionId: parentId.toString() } } : {}),
    });

    // Update running balances
    await applyRunningBalance(debitId,  fxAmount, 'debit');
    await applyRunningBalance(creditId, fxAmount, 'credit');

    reportCache.invalidate(String(businessId));
    logger.info(`[FX] Realised ${isGain ? 'gain' : 'loss'} of ${fxAmount} recorded — journal ${entry._id}`);
    return entry;
  }

  // ── Unrealised Month-End Revaluation ────────────────────────────────────────

  /**
   * IAS 21 §23(a): Monetary items shall be translated using the closing rate.
   *
   * For every open (unpaid / partially-paid) foreign-currency AR or AP transaction:
   *  1. Compute current base-currency value = foreignAmount × closingRate
   *  2. Compare to booked base-currency value
   *  3. If different, create an adjusting entry (tagged for reversal next month)
   *  4. Reverse any prior unrealised FX entries for the same source transaction to
   *     avoid double-counting.
   *
   * @param {string|ObjectId} businessId
   * @param {Date|string}     revaluationDate  typically last day of the month
   * @param {string|ObjectId} userId
   * @returns {Promise<{ created: number, skipped: number, errors: number }>}
   */
  async runMonthEndRevaluation(businessId, revaluationDate, userId) {
    const stats = { created: 0, skipped: 0, errors: 0 };
    const asOf  = new Date(revaluationDate);

    const baseCurrency = await fxService.getBaseCurrency(businessId);
    const fxAccts      = await this._getFxAccounts(businessId);

    if (!fxAccts.unrealised) {
      logger.warn(`[FX] Unrealised FX account (6210) missing for business ${businessId}`);
      return stats;
    }

    // Fetch all open foreign-currency monetary items
    const openItems = await JournalEntry.find({
      businessId,
      currencyCode: { $nin: [null, baseCurrency] },
      paymentStatus: { $in: ['unpaid', 'partially_paid'] },
      status: { $in: [JOURNAL_STATUS.POSTED, JOURNAL_STATUS.PARTIALLY_SETTLED] },
      isArchived: { $ne: true },
    })
      .populate('debitAccountId',  'accountName accountType normalBalance')
      .populate('creditAccountId', 'accountName accountType normalBalance')
      .lean();

    for (const tx of openItems) {
      try {
        // Determine if this is AR or AP
        const debitType  = tx.debitAccountId?.accountType;
        const creditType = tx.creditAccountId?.accountType;
        const isAR = debitType === 'Asset'   && tx.debitAccountId?.accountName?.toLowerCase().includes('receivable');
        const isAP = creditType === 'Liability' && tx.creditAccountId?.accountName?.toLowerCase().includes('payable');

        if (!isAR && !isAP) { stats.skipped++; continue; }

        // Foreign amount = tx.amount (stored in foreign currency)
        const foreignAmount = tx.amount;
        const bookingRate   = tx.exchangeRate || 1;
        const bookedBase    = tx.baseCurrencyAmount ?? (foreignAmount * bookingRate);

        const closingRate   = await fxService.getRate(businessId, tx.currencyCode, baseCurrency, asOf);
        const currentBase   = fxService.round(foreignAmount * closingRate, baseCurrency);

        const diff = fxService.round(currentBase - bookedBase, baseCurrency);
        if (Math.abs(diff) < 0.01) { stats.skipped++; continue; }

        // Reverse any prior unrealised entry for this source transaction (idempotent)
        await this._reversePriorUnrealisedEntry(businessId, tx._id, asOf, userId);

        // Create new unrealised adjusting entry. Direction is computed by the pure
        // helper so AR (asset) and AP (liability) get the correct IAS 21 polarity
        // (see audit A2 — the old inline branch booked payables backwards).
        const monetaryAccId = isAR ? tx.debitAccountId._id : tx.creditAccountId._id;
        const { isGain, absAmt, debitId, creditId } = buildUnrealisedFxRevaluation({
          isAR, diff, monetaryAccId, unrealisedAccId: fxAccts.unrealised._id,
        });

        // Post atomically through the canonical poster (audit A4): the JE and both
        // running-balance updates commit together, and the idempotencyKey makes a
        // re-run of the same month for the same source a no-op.
        const entry = await postCompoundJournal({
          businessId,
          transactionDate:   asOf,
          description:       `Unrealised FX Revaluation — ${tx.currencyCode}/${baseCurrency} (source: ${tx._id})`,
          transactionType:   TRANSACTION_TYPES.FX_REVALUATION,
          baseCurrencyAmount: absAmt,
          exchangeRate:      1,
          inputMethod:       INPUT_METHODS.FORM,
          status:            JOURNAL_STATUS.POSTED,
          transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
          entryType:        'adjusting',
          adjustingType:    'accrual',
          createdBy:        userId,
          lastModifiedBy:   userId,
          metadata: {
            unrealisedFx: true,
            fxSourceTransactionId: tx._id.toString(),
            closingRate,
            bookingRate,
            revaluationDate: asOf.toISOString(),
          },
          idempotencyKey: `fx:unrealised:${tx._id}:${asOf.toISOString()}`,
          lines: [
            { accountId: debitId,  type: 'debit',  amount: absAmt },
            { accountId: creditId, type: 'credit', amount: absAmt },
          ],
        });

        stats.created++;
        logger.info(`[FX] Unrealised revaluation for tx ${tx._id}: ${isGain ? '+' : '-'}${absAmt} ${baseCurrency}`);
      } catch (err) {
        stats.errors++;
        logger.error(`[FX] Revaluation error for tx ${tx._id}: ${err.message}`);
      }
    }

    reportCache.invalidate(String(businessId));
    logger.info(`[FX] Month-end revaluation complete for business ${businessId}: ${JSON.stringify(stats)}`);
    return stats;
  }

  /**
   * Reverse any previously posted unrealised FX entry for a given source transaction.
   * This prevents double-counting when revaluation is run more than once per period.
   * @private
   */
  async _reversePriorUnrealisedEntry(businessId, sourceTxId, asOf, userId) {
    const prior = await JournalEntry.findOne({
      businessId,
      transactionType: TRANSACTION_TYPES.FX_REVALUATION,
      status: JOURNAL_STATUS.POSTED,
      'metadata.unrealisedFx': true,
      'metadata.fxSourceTransactionId': sourceTxId.toString(),
    }).lean();

    if (!prior) return;

    // Create reversal (swap debit/credit)
    const rev = await JournalEntry.create({
      businessId,
      transactionDate:   asOf,
      description:       `Reversal of unrealised FX revaluation (source: ${sourceTxId})`,
      transactionType:   TRANSACTION_TYPES.FX_REVALUATION,
      amount:            prior.amount,
      baseCurrencyAmount: prior.amount,
      exchangeRate:      1,
      debitAccountId:    prior.creditAccountId,
      creditAccountId:   prior.debitAccountId,
      inputMethod:       INPUT_METHODS.FORM,
      status:            JOURNAL_STATUS.POSTED,
      transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
      entryType:        'adjusting',
      reversalOf:       prior._id,
      createdBy:        userId,
      lastModifiedBy:   userId,
      metadata: { unrealisedFxReversal: true, fxSourceTransactionId: sourceTxId.toString() },
    });

    await applyRunningBalance(rev.debitAccountId,  prior.amount, 'debit');
    await applyRunningBalance(rev.creditAccountId, prior.amount, 'credit');

    // Mark original as reversed
    await JournalEntry.findByIdAndUpdate(prior._id, { status: JOURNAL_STATUS.REVERSED });
    logger.info(`[FX] Reversed prior unrealised FX entry ${prior._id}`);
  }
}

module.exports = new JournalGeneratorService();
module.exports.buildUnrealisedFxRevaluation = buildUnrealisedFxRevaluation;

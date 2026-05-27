// controllers/fxRate.controller.js
// CRUD for per-business exchange rates + live rate sync + month-end FX revaluation.
const CurrencyRate         = require('../models/CurrencyRate.model');
const fxService            = require('../services/fx.service');
const rateSyncService      = require('../services/rateSync.service');
const journalGenerator     = require('../services/journalGenerator.service');
const { ApiError }         = require('../utils/ApiError');
const logger               = require('../config/logger');

class FxRateController {
  // ── GET /fx-rates ────────────────────────────────────────────────────────────
  /**
   * List exchange rates for the authenticated business.
   * Supports optional filters: fromCurrency, toCurrency, startDate, endDate.
   */
  async listRates(req, res, next) {
    try {
      const businessId = req.businessId;
      const { fromCurrency, toCurrency, startDate, endDate, page = 1, limit = 50 } = req.query;

      const filter = { businessId };
      if (fromCurrency) filter.fromCurrency = fromCurrency.toUpperCase();
      if (toCurrency)   filter.toCurrency   = toCurrency.toUpperCase();
      if (startDate || endDate) {
        filter.rateDate = {};
        if (startDate) filter.rateDate.$gte = new Date(startDate);
        if (endDate)   filter.rateDate.$lte = new Date(endDate);
      }

      const skip  = (page - 1) * limit;
      const [data, total] = await Promise.all([
        CurrencyRate.find(filter)
          .sort({ rateDate: -1, fromCurrency: 1 })
          .skip(skip)
          .limit(Number(limit))
          .lean(),
        CurrencyRate.countDocuments(filter),
      ]);

      res.json({
        success: true,
        data: { data, total, page: Number(page), limit: Number(limit) },
      });
    } catch (err) {
      next(err);
    }
  }

  // ── GET /fx-rates/pairs ──────────────────────────────────────────────────────
  /** Return distinct currency pairs configured for this business. */
  async listPairs(req, res, next) {
    try {
      const businessId = req.businessId;
      const pairs = await CurrencyRate.aggregate([
        { $match: { businessId } },
        { $group: { _id: { from: '$fromCurrency', to: '$toCurrency' } } },
        { $project: { _id: 0, fromCurrency: '$_id.from', toCurrency: '$_id.to' } },
        { $sort: { fromCurrency: 1, toCurrency: 1 } },
      ]);
      res.json({ success: true, data: pairs });
    } catch (err) {
      next(err);
    }
  }

  // ── GET /fx-rates/latest ────────────────────────────────────────────────────
  /**
   * Return the most recent rate for each pair (as-of today or provided date).
   * Useful for the currency picker in the transaction form.
   */
  async latestRates(req, res, next) {
    try {
      const businessId = req.businessId;
      const asOf = req.query.asOf ? new Date(req.query.asOf) : new Date();

      const pairs = await CurrencyRate.aggregate([
        { $match: { businessId, rateDate: { $lte: asOf } } },
        { $sort: { rateDate: -1 } },
        {
          $group: {
            _id: { from: '$fromCurrency', to: '$toCurrency' },
            rate:     { $first: '$rate' },
            rateDate: { $first: '$rateDate' },
            source:   { $first: '$source' },
          },
        },
        {
          $project: {
            _id: 0,
            fromCurrency: '$_id.from',
            toCurrency:   '$_id.to',
            rate: 1, rateDate: 1, source: 1,
          },
        },
        { $sort: { fromCurrency: 1, toCurrency: 1 } },
      ]);

      res.json({ success: true, data: pairs });
    } catch (err) {
      next(err);
    }
  }

  // ── GET /fx-rates/:id ───────────────────────────────────────────────────────
  async getRate(req, res, next) {
    try {
      const rate = await CurrencyRate.findOne({ _id: req.params.id, businessId: req.businessId }).lean();
      if (!rate) throw new ApiError(404, 'Exchange rate not found');
      res.json({ success: true, data: rate });
    } catch (err) {
      next(err);
    }
  }

  // ── POST /fx-rates ──────────────────────────────────────────────────────────
  /**
   * Upsert a single daily rate. If a record already exists for the same
   * businessId / fromCurrency / toCurrency / rateDate, it is overwritten.
   */
  async createRate(req, res, next) {
    try {
      const businessId = req.businessId;
      const { fromCurrency, toCurrency, rate, rateDate, source, notes } = req.body;

      const doc = await CurrencyRate.findOneAndUpdate(
        { businessId, fromCurrency, toCurrency, rateDate: new Date(rateDate) },
        { $set: { rate, source: source || 'manual', notes: notes || null } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );

      // Invalidate the in-process FX cache for this business
      fxService.invalidate(businessId);

      res.status(201).json({ success: true, data: doc });
    } catch (err) {
      // MongoDB duplicate key (race condition on the unique index) → treat as 409
      if (err.code === 11000) {
        return next(new ApiError(409, 'A rate for this currency pair on this date already exists'));
      }
      next(err);
    }
  }

  // ── POST /fx-rates/bulk ─────────────────────────────────────────────────────
  /**
   * Bulk upsert up to 200 rates in one call.
   * Useful for importing historical rates.
   */
  async bulkUpsertRates(req, res, next) {
    try {
      const businessId = req.businessId;
      const { rates }  = req.body;

      const ops = rates.map(r => ({
        updateOne: {
          filter: {
            businessId,
            fromCurrency: r.fromCurrency,
            toCurrency:   r.toCurrency,
            rateDate:     new Date(r.rateDate),
          },
          update: {
            $set: {
              rate:   r.rate,
              source: r.source || 'imported',
              notes:  r.notes  || null,
            },
          },
          upsert: true,
        },
      }));

      const result = await CurrencyRate.bulkWrite(ops, { ordered: false });
      fxService.invalidate(businessId);

      res.json({
        success: true,
        data: {
          upserted: result.upsertedCount,
          modified: result.modifiedCount,
          total:    rates.length,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  // ── PUT /fx-rates/:id ───────────────────────────────────────────────────────
  async updateRate(req, res, next) {
    try {
      const doc = await CurrencyRate.findOneAndUpdate(
        { _id: req.params.id, businessId: req.businessId },
        { $set: req.body },
        { new: true }
      );
      if (!doc) throw new ApiError(404, 'Exchange rate not found');
      fxService.invalidate(req.businessId);
      res.json({ success: true, data: doc });
    } catch (err) {
      next(err);
    }
  }

  // ── DELETE /fx-rates/:id ─────────────────────────────────────────────────────
  async deleteRate(req, res, next) {
    try {
      const doc = await CurrencyRate.findOneAndDelete({ _id: req.params.id, businessId: req.businessId });
      if (!doc) throw new ApiError(404, 'Exchange rate not found');
      fxService.invalidate(req.businessId);
      res.json({ success: true, message: 'Exchange rate deleted' });
    } catch (err) {
      next(err);
    }
  }

  // ── POST /fx-rates/sync ──────────────────────────────────────────────────────
  /**
   * Fetch live exchange rates from open.er-api.com (fallback: frankfurter.app)
   * and upsert today's rates for the authenticated business.
   *
   * Body (optional):
   *   currencies: string[]  — override default currency list
   *
   * Returns synced count, date, and the data source that responded.
   */
  async syncRates(req, res, next) {
    try {
      const businessId = req.businessId;
      const currencies = Array.isArray(req.body?.currencies) ? req.body.currencies : undefined;

      logger.info(`[FX] Manual rate sync triggered for business ${businessId}`);
      const result = await rateSyncService.syncForBusiness(businessId, currencies);

      res.json({
        success: true,
        message: `${result.synced} exchange rates updated from ${result.source}`,
        data: result,
      });
    } catch (err) {
      // Surface the real error so the frontend can show a useful message
      next(new ApiError(502, `Live rate fetch failed: ${err.message}`));
    }
  }

  // ── POST /fx-rates/revaluate ─────────────────────────────────────────────────
  /**
   * Trigger month-end unrealised FX revaluation for all open
   * foreign-currency AR/AP positions.
   */
  async runRevaluation(req, res, next) {
    try {
      const businessId     = req.businessId;
      const userId         = req.user._id;
      const revaluationDate = req.body?.revaluationDate
        ? new Date(req.body.revaluationDate)
        : new Date();

      logger.info(`[FX] Revaluation triggered for business ${businessId} as of ${revaluationDate.toISOString()} by user ${userId}`);

      const stats = await journalGenerator.runMonthEndRevaluation(businessId, revaluationDate, userId);

      res.json({
        success: true,
        message: `FX revaluation complete. ${stats.created} entries created, ${stats.skipped} skipped, ${stats.errors} errors.`,
        data: stats,
      });
    } catch (err) {
      next(err);
    }
  }

  // ── GET /fx-rates/convert ────────────────────────────────────────────────────
  /**
   * Quick conversion preview — no DB write.
   * GET /fx-rates/convert?from=USD&to=PKR&amount=1000&date=2024-01-15
   */
  async convertPreview(req, res, next) {
    try {
      const { from, to, amount, date } = req.query;
      if (!from || !to || !amount) {
        throw new ApiError(400, 'from, to, and amount are required');
      }
      const asOf   = date ? new Date(date) : new Date();
      const rate   = await fxService.getRate(req.businessId, from, to, asOf);
      const result = fxService.round(Number(amount) * rate, to);

      res.json({
        success: true,
        data: {
          from:          from.toUpperCase(),
          to:            to.toUpperCase(),
          amount:        Number(amount),
          rate,
          converted:     result,
          asOf:          asOf.toISOString().split('T')[0],
        },
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new FxRateController();

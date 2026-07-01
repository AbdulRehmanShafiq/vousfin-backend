// services/fixedAsset.service.js — Fixed Asset Register: depreciation + disposal
'use strict';
const { ApiError } = require('../utils/ApiError');
const FixedAsset = require('../models/FixedAsset.model');
const accountRepository = require('../repositories/account.repository');
const ledgerPosting = require('./ledgerPosting.service');

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Default chart-of-accounts codes used by the register.
const ACC = {
  DEP_EXPENSE: '6230',  // Depreciation Expense
  ACCUM_DEP: '1250',    // Accumulated Depreciation (contra-asset)
  CASH: '1010',         // Cash at Bank (disposal proceeds)
  GAIN: '4220',         // Gain on Asset Disposal
  LOSS: '6490',         // Loss on Asset Disposal
};

class FixedAssetService {
  // ── Pure math (no DB) ───────────────────────────────────────────────
  /** Annual depreciation schedule: straight-line or double-declining, never below salvage. */
  computeDepreciationSchedule(asset) {
    const cost = Number(asset.acquisitionCost) || 0;
    const salvage = Number(asset.salvageValue) || 0;
    const life = Math.max(1, Math.floor(Number(asset.usefulLifeYears) || 1));
    const method = asset.depreciationMethod || 'straight_line';
    const depreciable = Math.max(0, r2(cost - salvage));
    const rows = [];
    let accumulated = 0;

    if (method === 'declining_balance') {
      const rate = 2 / life; // double-declining
      let bookValue = cost;
      for (let year = 1; year <= life; year++) {
        let dep = r2(bookValue * rate);
        if (bookValue - dep < salvage) dep = r2(bookValue - salvage); // floor at salvage
        if (dep < 0) dep = 0;
        accumulated = r2(accumulated + dep);
        bookValue = r2(cost - accumulated);
        rows.push({ year, depreciation: dep, accumulated, bookValue });
      }
    } else {
      const annual = r2(depreciable / life);
      for (let year = 1; year <= life; year++) {
        let dep = annual;
        if (accumulated + dep > depreciable) dep = r2(depreciable - accumulated); // last-period catch-up
        if (dep < 0) dep = 0;
        accumulated = r2(accumulated + dep);
        rows.push({ year, depreciation: dep, accumulated, bookValue: r2(cost - accumulated) });
      }
    }
    return rows;
  }

  /** Net book value + gain/loss for a disposal at the given proceeds. */
  computeDisposal(asset, proceeds) {
    const cost = Number(asset.acquisitionCost) || 0;
    const accumulated = Number(asset.accumulatedDepreciation) || 0;
    const netBookValue = r2(cost - accumulated);
    const diff = r2((Number(proceeds) || 0) - netBookValue);
    return { netBookValue, gain: diff > 0 ? diff : 0, loss: diff < 0 ? r2(-diff) : 0 };
  }

  // ── CRUD ────────────────────────────────────────────────────────────
  async createAsset(businessId, data, actor) {
    return FixedAsset.create({ ...data, businessId, createdBy: (actor && (actor._id || actor.id)) || null });
  }
  async listAssets(businessId) {
    return FixedAsset.find({ businessId }).sort({ createdAt: -1 }).lean();
  }
  async getAsset(id, businessId) {
    const a = await FixedAsset.findOne({ _id: id, businessId });
    if (!a) throw new ApiError(404, 'Fixed asset not found');
    return a;
  }

  async _findAccountId(businessId, code) {
    try {
      const accts = await accountRepository.findAll({ businessId, accountCode: code }, { limit: 1 });
      return accts.data?.[0]?._id || null;
    } catch {
      return null;
    }
  }

  // ── Depreciation posting (one annual period per call) ───────────────
  async postDepreciation(assetId, businessId) {
    const asset = await this.getAsset(assetId, businessId);
    if (asset.status !== 'active') throw new ApiError(400, 'Only active assets can be depreciated.');

    const schedule = this.computeDepreciationSchedule(asset);
    const nextYear = (asset.depreciationPostedYears || 0) + 1;
    if (nextYear > schedule.length) throw new ApiError(409, 'This asset is already fully depreciated.');
    const row = schedule[nextYear - 1];

    if (!(row.depreciation > 0)) {
      asset.depreciationPostedYears = nextYear;
      if (nextYear >= schedule.length) asset.status = 'fully_depreciated';
      await asset.save();
      return { posted: false, asset };
    }

    const depExpenseId = await this._findAccountId(businessId, ACC.DEP_EXPENSE);
    const accumDepId = await this._findAccountId(businessId, ACC.ACCUM_DEP);
    if (!depExpenseId || !accumDepId) {
      throw new ApiError(422, 'Required accounts not found (Depreciation Expense 6230 / Accumulated Depreciation 1250).');
    }

    const je = await ledgerPosting.postCompoundJournal({
      businessId,
      transactionDate: new Date(),
      description: `Depreciation — ${asset.name} (year ${nextYear}/${schedule.length})`,
      transactionType: 'journal_entry',
      transactionSource: 'system_generated',
      inputMethod: 'system',
      lines: [
        { accountId: depExpenseId, type: 'debit', amount: row.depreciation, description: `Depreciation expense — ${asset.name} year ${nextYear}` },
        { accountId: accumDepId, type: 'credit', amount: row.depreciation, description: `Accumulated depreciation — ${asset.name} year ${nextYear}` },
      ],
      idempotencyKey: `fixedasset:${assetId}:dep:${nextYear}`,
    });

    asset.accumulatedDepreciation = r2((asset.accumulatedDepreciation || 0) + row.depreciation);
    asset.depreciationPostedYears = nextYear;
    asset.lastDepreciationDate = new Date();
    if (nextYear >= schedule.length) asset.status = 'fully_depreciated';
    await asset.save();
    return { posted: true, journalEntryId: je._id, asset };
  }

  // ── Scheduled / batch depreciation ──────────────────────────────────
  /**
   * Is the asset's NEXT annual depreciation period actually due as of `asOf`?
   * Guards the scheduled runner from posting a year before a full year has
   * elapsed. Pure (no DB). An asset with N years posted is due for year N+1 once
   * at least N+1 full years have elapsed since acquisition, while active and not
   * past its useful life.
   */
  isDepreciationDue(asset, asOf = new Date()) {
    if (!asset || asset.status !== 'active') return false;
    const posted = Number(asset.depreciationPostedYears) || 0;
    const life = Math.max(1, Math.floor(Number(asset.usefulLifeYears) || 1));
    if (posted >= life) return false;
    const acq = asset.acquisitionDate ? new Date(asset.acquisitionDate) : null;
    if (!acq || isNaN(acq.getTime())) return false;
    const elapsedYears = Math.floor((asOf - acq) / (365.25 * 24 * 3600 * 1000));
    return elapsedYears >= posted + 1;
  }

  /**
   * Post depreciation for every asset whose next annual period is due. Idempotent
   * (postDepreciation carries a per-year idempotency key) and fault-isolated: one
   * asset's failure never aborts the sweep. Optionally scoped to one business.
   * @returns {Promise<{scanned,due,posted,skipped,errors:Array}>}
   */
  async runDueDepreciation(asOf = new Date(), { businessId } = {}) {
    const query = { status: 'active' };
    if (businessId) query.businessId = businessId;
    const assets = await FixedAsset.find(query).lean();

    const result = { scanned: assets.length, due: 0, posted: 0, skipped: 0, errors: [] };
    for (const asset of assets) {
      if (!this.isDepreciationDue(asset, asOf)) { result.skipped++; continue; }
      result.due++;
      try {
        const r = await this.postDepreciation(asset._id, asset.businessId);
        if (r.posted) result.posted++; else result.skipped++;
      } catch (err) {
        result.errors.push({ assetId: String(asset._id), businessId: String(asset.businessId), error: err.message });
      }
    }
    return result;
  }

  // ── Disposal ────────────────────────────────────────────────────────
  async disposeAsset(assetId, businessId, { disposalDate, proceeds = 0 } = {}) {
    const asset = await this.getAsset(assetId, businessId);
    if (asset.status === 'disposed') throw new ApiError(409, 'Asset already disposed.');

    const { netBookValue, gain, loss } = this.computeDisposal(asset, proceeds);
    const p = Number(proceeds) || 0;

    const assetAcctId = await this._findAccountId(businessId, asset.assetAccountCode || '1220');
    const accumDepId = await this._findAccountId(businessId, ACC.ACCUM_DEP);
    if (!assetAcctId || !accumDepId) throw new ApiError(422, 'Required accounts not found for disposal.');

    const lines = [];
    if (asset.accumulatedDepreciation > 0) {
      lines.push({ accountId: accumDepId, type: 'debit', amount: asset.accumulatedDepreciation, description: `Remove accumulated depreciation — ${asset.name}` });
    }
    if (p > 0) {
      const cashId = await this._findAccountId(businessId, ACC.CASH);
      if (!cashId) throw new ApiError(422, 'Cash account (1010) not found for disposal proceeds.');
      lines.push({ accountId: cashId, type: 'debit', amount: p, description: `Disposal proceeds — ${asset.name}` });
    }
    lines.push({ accountId: assetAcctId, type: 'credit', amount: asset.acquisitionCost, description: `Remove asset cost — ${asset.name}` });
    if (gain > 0) {
      const gainId = await this._findAccountId(businessId, ACC.GAIN);
      if (!gainId) throw new ApiError(422, 'Gain on Asset Disposal account (4220) not found.');
      lines.push({ accountId: gainId, type: 'credit', amount: gain, description: `Gain on disposal — ${asset.name}` });
    }
    if (loss > 0) {
      const lossId = await this._findAccountId(businessId, ACC.LOSS);
      if (!lossId) throw new ApiError(422, 'Loss on Asset Disposal account (6490) not found.');
      lines.push({ accountId: lossId, type: 'debit', amount: loss, description: `Loss on disposal — ${asset.name}` });
    }

    const je = await ledgerPosting.postCompoundJournal({
      businessId,
      transactionDate: disposalDate ? new Date(disposalDate) : new Date(),
      description: `Asset disposal — ${asset.name} (NBV ${netBookValue}, proceeds ${p})`,
      transactionType: 'journal_entry',
      transactionSource: 'system_generated',
      inputMethod: 'system',
      lines,
      idempotencyKey: `fixedasset:${assetId}:disposal`,
    });

    asset.status = 'disposed';
    asset.disposalDate = disposalDate ? new Date(disposalDate) : new Date();
    asset.disposalProceeds = p;
    asset.disposalGainLoss = gain > 0 ? gain : -loss;
    await asset.save();
    return { journalEntryId: je._id, gain, loss, netBookValue, asset };
  }
}

module.exports = new FixedAssetService();

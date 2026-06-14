/**
 * tax.controller.js — Phase 5.4.3
 *
 * REST endpoints for managing business tax configuration:
 *  GET  /tax/config          — current tax config + effective country profile
 *  PUT  /tax/config          — update taxConfig (enable/disable taxes, set reg number, etc.)
 *  POST /tax/enable          — enable tax for a country + seed required CoA accounts
 *  GET  /tax/accounts        — list all tax accounts for this business
 *  POST /tax/preview         — calculate tax for a given amount (no DB write)
 *  GET  /tax/profiles        — list all supported country profiles (for UI dropdowns)
 *  GET  /tax/profiles/:code  — single country profile
 */

'use strict';

const Business           = require('../models/Business.model');
const ChartOfAccount     = require('../models/ChartOfAccount.model');
const taxEngine          = require('../services/taxEngine.service');
const taxReport          = require('../services/taxReport.service');   // Phase 5.4.6
const taxPosition        = require('../services/taxPosition.service');  // FR-04.1
const taxSnapshot        = require('../services/taxSnapshot.service');  // FR-04.1 (Phase 2)
const payrollRepo        = require('../repositories/payrollAccrual.repository');  // FR-04.1 (Phase 3)
const { getProfile, getSupportedCountries } = require('../config/countryTaxProfiles');
const { SUPPORTED_COUNTRIES } = require('../config/constants');
const { ApiError }       = require('../utils/ApiError');
const logger             = require('../config/logger');

class TaxController {

  // ── GET /tax/config ────────────────────────────────────────────────────────
  /**
   * Return the business's current taxConfig merged with the effective country profile.
   */
  async getConfig(req, res, next) {
    try {
      const business = await Business.findById(req.user.businessId, 'taxConfig currency').lean();
      if (!business) throw new ApiError(404, 'Business not found');

      const taxCfg  = business.taxConfig || {};
      const country = taxCfg.country || 'PK';
      const profile = getProfile(country);

      res.json({
        success: true,
        data: {
          taxConfig: taxCfg,
          profile: {
            country:              profile.country,
            countryName:          profile.countryName,
            defaultCurrency:      profile.defaultCurrency,
            taxIdentifierLabel:   profile.taxIdentifierLabel,
            filingFrequencyDefault: profile.filingFrequencyDefault,
            taxTypes:             profile.taxes.map(t => ({
              type: t.type, name: t.name, rate: t.rate, side: t.side,
            })),
            hasWht:               profile.whtSchedules.length > 0,
            hasReverseCharge:     profile.reverseChargeRules.length > 0,
            eInvoicingRequired:   profile.eInvoicingRequired || false,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }

  // ── PUT /tax/config ────────────────────────────────────────────────────────
  /**
   * Update tax configuration for the authenticated business.
   * Only the provided fields are changed (partial update).
   */
  async updateConfig(req, res, next) {
    try {
      const {
        country, taxRegistrationNumber,
        gstEnabled, vatEnabled, whtEnabled, reverseChargeEnabled,
        registeredForTax, taxInclusive, filingFrequency, customRates,
        incomeTaxProvisionRate, payrollEnabled,
      } = req.body;

      const update = {};

      if (country !== undefined) {
        if (!SUPPORTED_COUNTRIES.includes(country.toUpperCase())) {
          throw new ApiError(400, `Country ${country} is not supported. Supported: ${SUPPORTED_COUNTRIES.join(', ')}`);
        }
        update['taxConfig.country'] = country.toUpperCase();
      }
      if (taxRegistrationNumber !== undefined)  update['taxConfig.taxRegistrationNumber'] = taxRegistrationNumber || null;
      if (gstEnabled            !== undefined)  update['taxConfig.gstEnabled']            = !!gstEnabled;
      if (vatEnabled            !== undefined)  update['taxConfig.vatEnabled']            = !!vatEnabled;
      if (whtEnabled            !== undefined)  update['taxConfig.whtEnabled']            = !!whtEnabled;
      if (reverseChargeEnabled  !== undefined)  update['taxConfig.reverseChargeEnabled']  = !!reverseChargeEnabled;
      if (registeredForTax      !== undefined)  update['taxConfig.registeredForTax']      = !!registeredForTax;
      if (taxInclusive          !== undefined)  update['taxConfig.taxInclusive']          = !!taxInclusive;
      if (filingFrequency       !== undefined)  update['taxConfig.filingFrequency']       = filingFrequency;
      if (customRates           !== undefined)  update['taxConfig.customRates']           = new Map(Object.entries(customRates || {}));
      if (incomeTaxProvisionRate !== undefined) update['taxConfig.incomeTaxProvisionRate'] = incomeTaxProvisionRate;
      if (payrollEnabled        !== undefined)  update['taxConfig.payrollEnabled']         = !!payrollEnabled;

      const business = await Business.findByIdAndUpdate(
        req.user.businessId,
        { $set: update },
        { new: true, runValidators: true }
      ).lean();

      if (!business) throw new ApiError(404, 'Business not found');

      logger.info(`[Tax] Config updated for business ${req.user.businessId}`);
      res.json({ success: true, data: business.taxConfig, message: 'Tax configuration updated' });
    } catch (err) {
      next(err);
    }
  }

  // ── POST /tax/enable ───────────────────────────────────────────────────────
  /**
   * Enable tax for a given country + seed required CoA accounts.
   * Idempotent — calling multiple times is safe.
   *
   * Body: { country: 'PK' | 'AE' | 'SA' | 'IN' | 'US' | 'GB' }
   */
  async enableTax(req, res, next) {
    try {
      const country = (req.body.country || 'PK').toUpperCase();
      if (!SUPPORTED_COUNTRIES.includes(country)) {
        throw new ApiError(400, `Country ${country} is not supported`);
      }

      const profile = getProfile(country);

      // Determine which toggle to enable based on country
      const isPKGST  = ['PK'].includes(country);
      const isVAT    = ['AE', 'SA', 'GB'].includes(country);
      const isIndGST = ['IN'].includes(country);
      const isUST    = ['US'].includes(country);

      const taxFlagUpdate = {
        'taxConfig.country':            country,
        'taxConfig.gstEnabled':         isPKGST || isIndGST,
        'taxConfig.vatEnabled':         isVAT,
        'taxConfig.whtEnabled':         isPKGST || isIndGST || ['SA'].includes(country),
        'taxConfig.reverseChargeEnabled': ['AE', 'SA', 'IN'].includes(country),
        'taxConfig.registeredForTax':   true,
        'taxConfig.filingFrequency':    profile.filingFrequencyDefault || 'monthly',
      };
      if (isUST) {
        taxFlagUpdate['taxConfig.gstEnabled'] = false;
        taxFlagUpdate['taxConfig.vatEnabled'] = false;
      }

      await Business.findByIdAndUpdate(req.user.businessId, { $set: taxFlagUpdate }, { new: true });

      // Seed tax accounts
      const { created, skipped } = await taxEngine.ensureTaxAccounts(req.user.businessId, country);

      logger.info(`[Tax] Enabled ${country} tax for business ${req.user.businessId}: ${created} accounts created, ${skipped} skipped`);

      res.json({
        success: true,
        message: `Tax enabled for ${profile.countryName}. ${created} new accounts seeded, ${skipped} already existed.`,
        data: { country, created, skipped },
      });
    } catch (err) {
      next(err);
    }
  }

  // ── GET /tax/accounts ──────────────────────────────────────────────────────
  /**
   * Return all tax-related CoA accounts for this business.
   * Identified by well-known account code ranges (1170–1177, 2120–2130).
   */
  async listTaxAccounts(req, res, next) {
    try {
      const TAX_ACCOUNT_CODES = [
        '2120', '2121', '2122', '2123', '2124', '2125', '2126', '2127', '2128', '2129', '2130',
        '1170', '1171', '1172', '1173', '1174', '1175', '1176', '1177',
      ];

      const accounts = await ChartOfAccount.find({
        businessId: req.user.businessId,
        $or: [
          { accountCode: { $in: TAX_ACCOUNT_CODES } },
          { accountName: { $regex: /gst|vat|wht|cgst|sgst|igst|tds|srb|pra|sales tax/i } },
        ],
      }).sort({ accountCode: 1 }).lean();

      res.json({ success: true, data: accounts });
    } catch (err) {
      next(err);
    }
  }

  // ── POST /tax/preview ──────────────────────────────────────────────────────
  /**
   * Calculate tax preview for a given amount. Pure computation — no DB writes.
   * Powers the frontend TaxPreviewPanel (live, as the user types).
   *
   * Body: {
   *   amount, transactionType,
   *   mode ('inclusive'|'exclusive'),
   *   taxType?, taxRate?,
   *   isReverseCharge?, isImportedService?,   // ERP Step 6 — RC modes
   *   whtApply?, whtCategory?                  // ERP Step 6 — withholding
   * }
   */
  async preview(req, res, next) {
    try {
      const {
        amount, transactionType, mode, taxType, taxRate,
        isReverseCharge, isImportedService, whtApply, whtCategory,
      } = req.body;

      if (!amount || amount <= 0) throw new ApiError(400, 'amount must be > 0');
      if (!transactionType)       throw new ApiError(400, 'transactionType is required');

      const taxResult = await taxEngine.resolveApplicableTaxes({
        businessId:        req.user.businessId,
        transactionType,
        amount:            Number(amount),
        mode:              mode || 'inclusive',
        overrideTaxType:   taxType || null,
        overrideTaxRate:   taxRate || null,
        isReverseCharge:   isReverseCharge === true ? true : undefined,
        isImportedService: !!isImportedService,
        whtApply:          !!whtApply,
        whtCategory:       whtCategory || null,
      });

      // WHT is a deduction at source, not part of the price — surface the net
      // amount actually payable to / receivable from the party separately.
      const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
      const withholding = taxResult.lines.filter(l => l.isWithholding);
      const whtTotal    = r2(withholding.reduce((s, l) => s + (l.taxAmount || 0), 0));
      const hasReverseCharge = taxResult.lines.some(l => l.isReverseCharge);

      res.json({
        success: true,
        data: {
          taxApplied:   taxResult.taxApplied,
          totalTax:     taxResult.totalTax,
          netAmount:    taxResult.netAmount,
          grossAmount:  taxResult.grossAmount,
          countryCode:  taxResult.countryCode,
          whtTotal,
          netPayable:   whtTotal > 0 ? r2(taxResult.grossAmount - whtTotal) : null,
          hasReverseCharge,
          lines: taxResult.lines.map(l => ({
            taxType:         l.taxType,
            taxName:         l.taxName,
            rate:            l.rate,
            taxAmount:       l.taxAmount,
            side:            l.side,
            isWithholding:   !!l.isWithholding,
            isReverseCharge: !!l.isReverseCharge,
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  }

  // ── GET /tax/profiles ──────────────────────────────────────────────────────
  /** Return summary list of all supported country profiles. */
  async listProfiles(req, res, next) {
    try {
      const countries = getSupportedCountries();
      const profiles = countries.map(code => {
        const p = getProfile(code);
        return {
          country:          p.country,
          countryName:      p.countryName,
          defaultCurrency:  p.defaultCurrency,
          taxIdentifierLabel: p.taxIdentifierLabel,
          primaryTaxType:   p.taxes[0]?.type,
          primaryTaxRate:   p.taxes[0]?.rate,
          hasWht:           p.whtSchedules.length > 0,
          hasReverseCharge: p.reverseChargeRules.length > 0,
        };
      });
      res.json({ success: true, data: profiles });
    } catch (err) {
      next(err);
    }
  }

  // ── GET /tax/profiles/:code ────────────────────────────────────────────────
  /** Return full profile for one country. */
  async getProfile(req, res, next) {
    try {
      const code = req.params.code?.toUpperCase();
      if (!SUPPORTED_COUNTRIES.includes(code)) {
        throw new ApiError(404, `Country "${code}" not supported. Use one of: ${SUPPORTED_COUNTRIES.join(', ')}`);
      }
      const profile = getProfile(code);
      res.json({ success: true, data: profile });
    } catch (err) {
      next(err);
    }
  }

  // ── PUT /tax/vendor/:id/wht ────────────────────────────────────────────────
  /**
   * Update the WHT profile on a vendor (Phase 5.4.4).
   * Replaces the vendor's whtProfile subdocument.
   *
   * Body: { enabled, category, isNonFiler, customRate, strn }
   */
  async updateVendorWht(req, res, next) {
    try {
      const Vendor = require('../models/Vendor.model');
      const { id } = req.params;
      const { enabled, category, isNonFiler, customRate, strn } = req.body;

      const vendor = await Vendor.findOneAndUpdate(
        { _id: id, businessId: req.user.businessId },
        {
          $set: {
            'whtProfile.enabled':    !!enabled,
            'whtProfile.category':   category   || null,
            'whtProfile.isNonFiler': !!isNonFiler,
            'whtProfile.customRate': customRate  ?? null,
            'whtProfile.strn':       strn        || null,
          },
        },
        { new: true, runValidators: true }
      ).lean();

      if (!vendor) throw new ApiError(404, 'Vendor not found');

      logger.info(`[WHT] Updated WHT profile for vendor ${id}, category: ${category}, enabled: ${enabled}`);
      res.json({ success: true, data: vendor.whtProfile, message: 'Vendor WHT profile updated' });
    } catch (err) {
      next(err);
    }
  }

  // ── GET /tax/wht-schedules ─────────────────────────────────────────────────
  /**
   * Return WHT schedules for the business's current country.
   * Used to populate the WHT category dropdown on the vendor form.
   */
  async getWhtSchedules(req, res, next) {
    try {
      const { config } = await taxEngine.getBusinessTaxConfig(req.user.businessId);
      const country = config.country || 'PK';
      const profile = getProfile(country);
      res.json({ success: true, data: profile.whtSchedules, country });
    } catch (err) {
      next(err);
    }
  }

  // ── GET /tax/reports/ledger ────────────────────────────────────────────────
  /**
   * All tax transactions in a date range.
   * Query: ?startDate=2025-01-01&endDate=2025-03-31
   */
  async taxLedger(req, res, next) {
    try {
      const { startDate, endDate } = req.query;
      const data = await taxReport.getTaxLedger(req.user.businessId, {
        startDate: startDate ? new Date(startDate) : null,
        endDate:   endDate   ? new Date(endDate)   : null,
      });
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  // ── GET /tax/reports/summary ───────────────────────────────────────────────
  /**
   * Input vs output tax summary + net payable.
   */
  async taxSummary(req, res, next) {
    try {
      const { startDate, endDate } = req.query;
      const { config } = await taxEngine.getBusinessTaxConfig(req.user.businessId);
      const data = await taxReport.getTaxSummary(
        req.user.businessId,
        {
          startDate: startDate ? new Date(startDate) : null,
          endDate:   endDate   ? new Date(endDate)   : null,
        },
        config.country || 'PK'
      );
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  // ── GET /tax/reports/wht ───────────────────────────────────────────────────
  /**
   * WHT deducted per vendor for the period.
   */
  async whtSummary(req, res, next) {
    try {
      const { startDate, endDate } = req.query;
      const data = await taxReport.getWhtSummary(req.user.businessId, {
        startDate: startDate ? new Date(startDate) : null,
        endDate:   endDate   ? new Date(endDate)   : null,
      });
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  // ── GET /tax/reports/filing ────────────────────────────────────────────────
  /**
   * Filing-ready summary structured for the business's country tax return.
   * Pakistan → GST-101, UAE/SA → VAT-201, India → GSTR-3B
   */
  async filingSummary(req, res, next) {
    try {
      const { startDate, endDate } = req.query;
      const { config } = await taxEngine.getBusinessTaxConfig(req.user.businessId);
      const data = await taxReport.getFilingSummary(
        req.user.businessId,
        {
          startDate: startDate ? new Date(startDate) : null,
          endDate:   endDate   ? new Date(endDate)   : null,
        },
        config.country || 'PK'
      );
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  // ── GET /tax/position ──────────────────────────────────────────────────────
  /**
   * Live, always-on tax position across every applicable tax type (FR-04.1).
   * No query params — it's the current state, computed from the live ledger.
   */
  async getPosition(req, res, next) {
    try {
      const data = await taxPosition.getLivePosition(req.user.businessId);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  // ── GET /tax/position/trend ────────────────────────────────────────────────
  /**
   * The tax-position trend over the last N months (default 6) — daily snapshots
   * for sparklines + "how your liability moved" charts (FR-04.1, Phase 2).
   * Query: ?months=6
   */
  async getPositionTrend(req, res, next) {
    try {
      const months = Number(req.query.months) || 6;
      const data = await taxSnapshot.getTrend(req.user.businessId, months);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  // ── POST /tax/payroll-accrual ──────────────────────────────────────────────
  /**
   * Record (or overwrite) a month's employer EOBI/SESSI obligation so the live
   * position can track payroll taxes (FR-04.1, Phase 3). Idempotent per month.
   * Body: { month?: 'YYYY-MM' (default current), eobi?: number, sessi?: number }
   */
  async addPayrollAccrual(req, res, next) {
    try {
      const { eobi = 0, sessi = 0 } = req.body;
      const month = req.body.month || new Date().toISOString().slice(0, 7); // 'YYYY-MM'
      const accrual = await payrollRepo.upsertForMonth(req.user.businessId, month, {
        eobi, sessi, createdBy: req.user._id || req.user.id || null,
      });
      res.json({ success: true, data: accrual, message: `Payroll accrual saved for ${month}` });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new TaxController();

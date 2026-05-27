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
const { getProfile, getSupportedCountries, getApplicableTaxes } = require('../config/countryTaxProfiles');
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
      const business = await Business.findById(req.businessId, 'taxConfig currency').lean();
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

      const business = await Business.findByIdAndUpdate(
        req.businessId,
        { $set: update },
        { new: true, runValidators: true }
      ).lean();

      if (!business) throw new ApiError(404, 'Business not found');

      logger.info(`[Tax] Config updated for business ${req.businessId}`);
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

      await Business.findByIdAndUpdate(req.businessId, { $set: taxFlagUpdate }, { new: true });

      // Seed tax accounts
      const { created, skipped } = await taxEngine.ensureTaxAccounts(req.businessId, country);

      logger.info(`[Tax] Enabled ${country} tax for business ${req.businessId}: ${created} accounts created, ${skipped} skipped`);

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
        businessId: req.businessId,
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
   * Useful for the frontend TaxPreviewPanel (Phase 5.4.8).
   *
   * Body: { amount, transactionType, mode ('inclusive'|'exclusive'), taxType?, taxRate? }
   */
  async preview(req, res, next) {
    try {
      const { amount, transactionType, mode, taxType, taxRate } = req.body;

      if (!amount || amount <= 0) throw new ApiError(400, 'amount must be > 0');
      if (!transactionType)       throw new ApiError(400, 'transactionType is required');

      const taxResult = await taxEngine.resolveApplicableTaxes({
        businessId:      req.businessId,
        transactionType,
        amount:          Number(amount),
        mode:            mode || 'inclusive',
        overrideTaxType: taxType || null,
        overrideTaxRate: taxRate || null,
      });

      res.json({
        success: true,
        data: {
          taxApplied:   taxResult.taxApplied,
          totalTax:     taxResult.totalTax,
          netAmount:    taxResult.netAmount,
          grossAmount:  taxResult.grossAmount,
          countryCode:  taxResult.countryCode,
          lines: taxResult.lines.map(l => ({
            taxType:     l.taxType,
            taxName:     l.taxName,
            rate:        l.rate,
            taxAmount:   l.taxAmount,
            side:        l.side,
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
}

module.exports = new TaxController();

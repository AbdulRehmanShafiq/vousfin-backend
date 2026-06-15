// config/taxOptimizationRules.js
//
// FR-04.2 — deterministic, auditable tax-optimisation rule catalog (Pakistan).
//
// Each rule is data, not magic: it cites a real legal provision, computes a PKR
// saving from the supplied context, and declares its risk level. `detect(ctx)`
// returns null (no advisory) or { estimatedSavingPKR, explanation }. The catalog
// is intentionally expandable — add rules here, no service change needed.
//
// riskLevel: 'safe'   — your money / a clear entitlement, low judgement.
//            'review' — depends on projections or facts to verify first; the
//                       advisor attaches a prominent warning to these.
//
'use strict';

const r0    = (v) => Math.round(Number(v) || 0);                 // whole rupees
const money = (v) => `Rs ${r0(v).toLocaleString('en-PK')}`;
const pct   = (f) => `${Math.round(f * 100)}%`;

// Conservative blended first-year tax depreciation. PK Third Schedule rates vary
// (furniture 10%, plant & machinery 15%, computers 30%); 10% is a safe lower bound.
const DEPRECIATION_RATE = 0.10;

const TAX_OPTIMIZATION_RULES = [
  {
    id: 'DEPRECIATION_UNCLAIMED',
    taxType: 'INCOME_TAX',
    title: 'Claim depreciation on your fixed assets',
    legalRef: 'Income Tax Ordinance 2001, s.22 & Third Schedule',
    riskLevel: 'safe',
    detect(ctx) {
      if (!(ctx.fixedAssetsGross > 0)) return null;
      if (ctx.depreciationBookedYTD > 0) return null;      // already depreciating
      const annualDepreciation = r0(DEPRECIATION_RATE * ctx.fixedAssetsGross);
      const saving = r0((ctx.provisionRate || 0.29) * annualDepreciation);
      if (saving <= 0) return null;
      return {
        estimatedSavingPKR: saving,
        explanation: `You hold ${money(ctx.fixedAssetsGross)} of fixed assets but have booked no depreciation this year. Claiming the tax depreciation allowance (~${pct(DEPRECIATION_RATE)} of cost) lowers taxable income by about ${money(annualDepreciation)}, cutting income tax by roughly ${money(saving)}.`,
      };
    },
  },

  {
    id: 'INPUT_TAX_UNCLAIMED',
    taxType: 'GST',
    title: 'Recover your excess input sales tax',
    legalRef: 'Sales Tax Act 1990, s.7 & s.10',
    riskLevel: 'safe',
    detect(ctx) {
      if (!(ctx.glNetPayable < 0)) return null;            // input already exceeds output
      const claimable = r0(-ctx.glNetPayable);
      if (claimable <= 0) return null;
      return {
        estimatedSavingPKR: claimable,
        explanation: `Your input sales tax exceeds output tax by ${money(claimable)} this period. Rather than leaving it on the table, carry the excess forward or claim a refund under s.10.`,
      };
    },
  },

  {
    id: 'ADVANCE_TAX_OVERPAID',
    taxType: 'INCOME_TAX',
    title: 'You may have overpaid advance tax',
    legalRef: 'Income Tax Ordinance 2001, s.147 & s.170 (refund)',
    riskLevel: 'review',
    detect(ctx) {
      if (!(ctx.advanceTaxPaid > 0)) return null;
      const expectedLiability = r0((ctx.provisionRate || 0.29) * Math.max(0, ctx.projectedAnnualIncome || 0));
      const excess = r0(ctx.advanceTaxPaid - expectedLiability);
      if (excess <= 0) return null;
      return {
        estimatedSavingPKR: excess,
        explanation: `Advance tax already paid/withheld (${money(ctx.advanceTaxPaid)}) is higher than your projected annual income-tax liability (${money(expectedLiability)}). The ${money(excess)} excess can be adjusted against your next instalment or claimed as a refund under s.170.`,
      };
    },
  },

  {
    id: 'WHT_SECTION_OPTIMISATION',
    taxType: 'WHT',
    title: 'Verify filer status before withholding',
    legalRef: 'Income Tax Ordinance 2001, s.153 & Tenth Schedule (non-filer rates)',
    riskLevel: 'review',
    detect(ctx) {
      if (!(ctx.whtWithheldYTD > 1000)) return null;       // ignore trivial amounts
      const potential = r0(ctx.whtWithheldYTD * 0.5);      // non-filer rates ~2× filer rates
      return {
        estimatedSavingPKR: potential,
        explanation: `You withheld ${money(ctx.whtWithheldYTD)} of tax this year. Where counterparties are active filers (on the FBR ATL), withholding is roughly half the non-filer rate — verifying filer status before payment could reduce withholding by up to ${money(potential)}.`,
      };
    },
  },
];

module.exports = { TAX_OPTIMIZATION_RULES, DEPRECIATION_RATE };

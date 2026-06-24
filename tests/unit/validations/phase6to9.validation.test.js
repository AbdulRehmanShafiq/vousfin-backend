'use strict';
/**
 * TDD: Phase 6-9 input validation schemas — W4 hardening
 *
 * Tests:
 *  1. Lease validation (assetName required, discountRate 0-1, monthlyPayment ≥0,
 *     leaseTerm int 1-600, commencementDate date)
 *  2. Impairment validation (assetName required, carryingAmount ≥0, recoverableAmount ≥0)
 *  3. AML justify validation (justification max 1000 chars)
 *  4. Compliance generate validation (year 2000-2100)
 *  5. 13-week floor query (≥0, defaults to 0)
 *  6. InternalAudit plan validation (periodEnd ≥ periodStart via Joi.ref, sampleSize 1-100)
 */

const {
  createLeaseSchema,
  createImpairmentSchema,
  amlJustifySchema,
  complianceGenerateSchema,
  thirteenWeekQuerySchema,
} = require('../../../validations/lease.validation');

const { createPlanSchema } = require('../../../validations/internalAudit.validation');

const V_OPTS = { abortEarly: false, allowUnknown: false };

// ── helpers ────────────────────────────────────────────────────────────────
function ok(schema, value) {
  const { error } = schema.validate(value, V_OPTS);
  return error === undefined;
}
function err(schema, value) {
  const { error } = schema.validate(value, V_OPTS);
  return error !== undefined;
}
function errMsg(schema, value) {
  const { error } = schema.validate(value, V_OPTS);
  return error ? error.details.map(d => d.message).join('; ') : '';
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Lease
// ════════════════════════════════════════════════════════════════════════════
describe('createLeaseSchema', () => {
  const validLease = {
    assetName: 'Office space',
    commencementDate: '2025-01-01',
    leaseTerm: 36,
    monthlyPayment: 50000,
    discountRate: 0.12,
  };

  it('accepts a valid lease payload', () => {
    expect(ok(createLeaseSchema, validLease)).toBe(true);
  });

  it('requires assetName', () => {
    const { assetName: _, ...rest } = validLease;
    expect(err(createLeaseSchema, rest)).toBe(true);
    expect(errMsg(createLeaseSchema, rest)).toMatch(/assetName/i);
  });

  it('rejects discountRate > 1', () => {
    expect(err(createLeaseSchema, { ...validLease, discountRate: 1.5 })).toBe(true);
  });

  it('rejects discountRate < 0', () => {
    expect(err(createLeaseSchema, { ...validLease, discountRate: -0.1 })).toBe(true);
  });

  it('accepts discountRate = 0', () => {
    expect(ok(createLeaseSchema, { ...validLease, discountRate: 0 })).toBe(true);
  });

  it('accepts discountRate = 1', () => {
    expect(ok(createLeaseSchema, { ...validLease, discountRate: 1 })).toBe(true);
  });

  it('rejects monthlyPayment < 0', () => {
    expect(err(createLeaseSchema, { ...validLease, monthlyPayment: -1 })).toBe(true);
  });

  it('accepts monthlyPayment = 0', () => {
    expect(ok(createLeaseSchema, { ...validLease, monthlyPayment: 0 })).toBe(true);
  });

  it('rejects leaseTerm = 0', () => {
    expect(err(createLeaseSchema, { ...validLease, leaseTerm: 0 })).toBe(true);
  });

  it('rejects leaseTerm = 601', () => {
    expect(err(createLeaseSchema, { ...validLease, leaseTerm: 601 })).toBe(true);
  });

  it('accepts leaseTerm = 1', () => {
    expect(ok(createLeaseSchema, { ...validLease, leaseTerm: 1 })).toBe(true);
  });

  it('accepts leaseTerm = 600', () => {
    expect(ok(createLeaseSchema, { ...validLease, leaseTerm: 600 })).toBe(true);
  });

  it('rejects non-integer leaseTerm', () => {
    expect(err(createLeaseSchema, { ...validLease, leaseTerm: 3.5 })).toBe(true);
  });

  it('requires commencementDate', () => {
    const { commencementDate: _, ...rest } = validLease;
    expect(err(createLeaseSchema, rest)).toBe(true);
  });

  it('rejects commencementDate as non-date string', () => {
    expect(err(createLeaseSchema, { ...validLease, commencementDate: 'not-a-date' })).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Impairment
// ════════════════════════════════════════════════════════════════════════════
describe('createImpairmentSchema', () => {
  const validImp = {
    assetName: 'Machine A',
    carryingAmount: 100000,
    recoverableAmount: 80000,
  };

  it('accepts a valid impairment payload', () => {
    expect(ok(createImpairmentSchema, validImp)).toBe(true);
  });

  it('requires assetName', () => {
    const { assetName: _, ...rest } = validImp;
    expect(err(createImpairmentSchema, rest)).toBe(true);
  });

  it('rejects carryingAmount < 0', () => {
    expect(err(createImpairmentSchema, { ...validImp, carryingAmount: -1 })).toBe(true);
  });

  it('accepts carryingAmount = 0', () => {
    expect(ok(createImpairmentSchema, { ...validImp, carryingAmount: 0 })).toBe(true);
  });

  it('rejects recoverableAmount < 0', () => {
    expect(err(createImpairmentSchema, { ...validImp, recoverableAmount: -1 })).toBe(true);
  });

  it('accepts recoverableAmount = 0', () => {
    expect(ok(createImpairmentSchema, { ...validImp, recoverableAmount: 0 })).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. AML justify
// ════════════════════════════════════════════════════════════════════════════
describe('amlJustifySchema', () => {
  it('accepts a valid justification', () => {
    expect(ok(amlJustifySchema, { justification: 'This counterparty was reviewed and cleared.' })).toBe(true);
  });

  it('rejects justification > 1000 chars', () => {
    const long = 'a'.repeat(1001);
    expect(err(amlJustifySchema, { justification: long })).toBe(true);
  });

  it('accepts justification of exactly 1000 chars', () => {
    const exact = 'a'.repeat(1000);
    expect(ok(amlJustifySchema, { justification: exact })).toBe(true);
  });

  it('accepts empty / missing justification (optional field)', () => {
    expect(ok(amlJustifySchema, {})).toBe(true);
    expect(ok(amlJustifySchema, { justification: '' })).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Compliance generate
// ════════════════════════════════════════════════════════════════════════════
describe('complianceGenerateSchema', () => {
  it('accepts a valid year', () => {
    expect(ok(complianceGenerateSchema, { year: 2025 })).toBe(true);
  });

  it('rejects year < 2000', () => {
    expect(err(complianceGenerateSchema, { year: 1999 })).toBe(true);
  });

  it('rejects year > 2100', () => {
    expect(err(complianceGenerateSchema, { year: 2101 })).toBe(true);
  });

  it('accepts boundary years 2000 and 2100', () => {
    expect(ok(complianceGenerateSchema, { year: 2000 })).toBe(true);
    expect(ok(complianceGenerateSchema, { year: 2100 })).toBe(true);
  });

  it('requires year', () => {
    expect(err(complianceGenerateSchema, {})).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. 13-week floor query
// ════════════════════════════════════════════════════════════════════════════
describe('thirteenWeekQuerySchema', () => {
  it('accepts floor=0', () => {
    const { value } = thirteenWeekQuerySchema.validate({ floor: 0 });
    expect(value.floor).toBe(0);
  });

  it('accepts floor=500000', () => {
    const { value } = thirteenWeekQuerySchema.validate({ floor: 500000 });
    expect(value.floor).toBe(500000);
  });

  it('rejects floor < 0', () => {
    expect(err(thirteenWeekQuerySchema, { floor: -1 })).toBe(true);
  });

  it('defaults floor to 0 when absent', () => {
    const { value } = thirteenWeekQuerySchema.validate({});
    expect(value.floor).toBe(0);
  });

  it('coerces string floor to number', () => {
    // Joi query schemas often receive strings from Express query params
    const { value } = thirteenWeekQuerySchema.validate({ floor: '1000' });
    expect(value.floor).toBe(1000);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. InternalAudit plan
// ════════════════════════════════════════════════════════════════════════════
describe('createPlanSchema — periodEnd >= periodStart + sampleSize 1-100', () => {
  const base = {
    name: 'Q1 2025 Audit',
    periodStart: '2025-01-01',
    periodEnd: '2025-03-31',
    sampleSize: 10,
  };

  it('accepts a valid plan', () => {
    expect(ok(createPlanSchema, base)).toBe(true);
  });

  it('rejects sampleSize = 0', () => {
    expect(err(createPlanSchema, { ...base, sampleSize: 0 })).toBe(true);
  });

  it('rejects sampleSize = 101', () => {
    expect(err(createPlanSchema, { ...base, sampleSize: 101 })).toBe(true);
  });

  it('accepts sampleSize = 1', () => {
    expect(ok(createPlanSchema, { ...base, sampleSize: 1 })).toBe(true);
  });

  it('accepts sampleSize = 100', () => {
    expect(ok(createPlanSchema, { ...base, sampleSize: 100 })).toBe(true);
  });

  it('rejects periodEnd before periodStart', () => {
    expect(err(createPlanSchema, { ...base, periodEnd: '2024-12-31' })).toBe(true);
  });

  it('accepts periodEnd equal to periodStart', () => {
    expect(ok(createPlanSchema, { ...base, periodEnd: '2025-01-01' })).toBe(true);
  });
});

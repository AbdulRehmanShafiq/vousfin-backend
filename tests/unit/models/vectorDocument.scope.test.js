'use strict';

const mongoose = require('mongoose');
const VectorDocument = require('../../../models/VectorDocument.model');
const { GLOBAL_CATALOG_BUSINESS_ID } = require('../../../config/constants');

const base = {
  businessId: new mongoose.Types.ObjectId(),
  dataType: 'monthly_pnl',
  recordId: 'r1',
  period: '2026-06',
  summary: 'x',
  embedding: [1, 0, 0],
  summaryHash: 'h',
};

describe('VectorDocument.scope', () => {
  it('defaults scope to "tenant" so existing financial vectors are unaffected', () => {
    const d = new VectorDocument({ ...base });
    expect(d.scope).toBe('tenant');
  });

  it('accepts "global" for app-catalog vectors', () => {
    const d = new VectorDocument({ ...base, scope: 'global', dataType: 'app_catalog' });
    expect(d.scope).toBe('global');
  });

  it('rejects an unknown scope value', () => {
    const d = new VectorDocument({ ...base, scope: 'bogus' });
    const err = d.validateSync();
    expect(err?.errors?.scope).toBeTruthy();
  });
});

describe('GLOBAL_CATALOG_BUSINESS_ID', () => {
  it('is a valid ObjectId reserved for the global catalog', () => {
    expect(mongoose.Types.ObjectId.isValid(GLOBAL_CATALOG_BUSINESS_ID)).toBe(true);
  });
});

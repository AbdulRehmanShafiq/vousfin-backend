'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../services/embeddingService', () => ({
  embedQuery: jest.fn().mockResolvedValue([1, 0, 0]),
}));
jest.mock('../../../services/vectorStore.service', () => ({
  searchSimilar: jest.fn(),
}));

const { GLOBAL_CATALOG_BUSINESS_ID } = require('../../../config/constants');
const vectorStore = require('../../../services/vectorStore.service');
const { searchCatalog } = require('../../../services/catalogSearch.service');

const hit = (id, moduleKey, enablementKey, score, extra = {}) => ({
  recordId: id,
  businessId: GLOBAL_CATALOG_BUSINESS_ID,
  vectorScore: score,
  metadata: { title: id, href: `/${id}`, type: 'page', path: ['X', id], moduleKey, enablementKey, ...extra },
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CATALOG_SEARCH_MIN_SCORE = '0.15';
});

describe('searchCatalog', () => {
  it('queries ONLY the global sentinel businessId + app_catalog dataType (isolation)', async () => {
    vectorStore.searchSimilar.mockResolvedValue([]);
    await searchCatalog('invoices', {});
    const call = vectorStore.searchSimilar.mock.calls[0];
    const [, bizId, , opts] = call;
    // It must never be able to read a real tenant's vectors: it always asks for
    // the reserved global sentinel and the app_catalog dataType.
    expect(String(bizId)).toBe(GLOBAL_CATALOG_BUSINESS_ID);
    expect(opts.dataTypes).toEqual(['app_catalog']);
  });

  it('maps vector hits to catalog result entries', async () => {
    vectorStore.searchSimilar.mockResolvedValue([hit('sales.invoices', 'sales', null, 0.82)]);
    const r = await searchCatalog('invoices', {});
    expect(r[0]).toMatchObject({ id: 'sales.invoices', title: 'sales.invoices', href: '/sales.invoices', moduleKey: 'sales' });
    expect(r[0].score).toBeCloseTo(0.82);
  });

  it('omits results for a disabled module', async () => {
    vectorStore.searchSimilar.mockResolvedValue([
      hit('sales.invoices', 'sales', null, 0.8),
      hit('payroll.payslips', 'payroll', 'payroll', 0.7),
    ]);
    const r = await searchCatalog('pay', { disabledModules: ['payroll'] });
    expect(r.some((e) => e.moduleKey === 'payroll')).toBe(false);
    expect(r.some((e) => e.id === 'sales.invoices')).toBe(true);
  });

  it('drops hits below the score threshold', async () => {
    vectorStore.searchSimilar.mockResolvedValue([
      hit('strong', 'sales', null, 0.8),
      hit('weak', 'sales', null, 0.04),
    ]);
    const r = await searchCatalog('x', {});
    expect(r.map((e) => e.id)).toEqual(['strong']);
  });

  it('returns [] for an empty query without calling the vector store', async () => {
    const r = await searchCatalog('   ', {});
    expect(r).toEqual([]);
    expect(vectorStore.searchSimilar).not.toHaveBeenCalled();
  });
});

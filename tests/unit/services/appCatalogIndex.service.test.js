'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../services/embeddingService', () => ({
  embedDocuments: jest.fn(),
}));
jest.mock('../../../services/vectorStore.service', () => ({
  upsertEmbedding: jest.fn().mockResolvedValue({ upserted: true }),
}));

const { GLOBAL_CATALOG_BUSINESS_ID } = require('../../../config/constants');
const embeddingService = require('../../../services/embeddingService');
const vectorStore = require('../../../services/vectorStore.service');
const svc = require('../../../services/appCatalogIndex.service');

const ENTRIES = [
  { id: 'sales.invoices', type: 'page', title: 'Invoices', path: ['Sales', 'Invoices'], href: '/sales/invoices', synonyms: ['bills', 'receivable'], moduleKey: 'sales', enablementKey: null },
  { id: 'payroll', type: 'module', title: 'Payroll', path: ['Payroll'], href: '/payroll', synonyms: ['pay'], moduleKey: 'payroll', enablementKey: 'payroll' },
];

beforeEach(() => {
  jest.clearAllMocks();
  embeddingService.embedDocuments.mockResolvedValue(ENTRIES.map(() => [0.1, 0.2, 0.3]));
});

describe('catalogSearchText', () => {
  it('combines title, breadcrumb and synonyms into one searchable string', () => {
    const t = svc.catalogSearchText(ENTRIES[0]);
    expect(t).toMatch(/Invoices/);
    expect(t).toMatch(/bills/);
    expect(t).toMatch(/Sales/);
  });
});

describe('buildCatalogDocs', () => {
  it('maps an entry to a GLOBAL-scope app_catalog vector payload', () => {
    const [doc] = svc.buildCatalogDocs(ENTRIES);
    expect(doc).toMatchObject({
      businessId: GLOBAL_CATALOG_BUSINESS_ID,
      scope: 'global',
      dataType: 'app_catalog',
      recordId: 'sales.invoices',
      period: 'static',
    });
    expect(doc.metadata).toMatchObject({ title: 'Invoices', href: '/sales/invoices', type: 'page', moduleKey: 'sales', enablementKey: null });
    expect(typeof doc.summaryHash).toBe('string');
  });
});

describe('reindexAppCatalog', () => {
  it('embeds every entry and upserts it under the global scope', async () => {
    const stats = await svc.reindexAppCatalog({ entries: ENTRIES });
    expect(embeddingService.embedDocuments).toHaveBeenCalledTimes(1);
    expect(vectorStore.upsertEmbedding).toHaveBeenCalledTimes(2);
    const firstPayload = vectorStore.upsertEmbedding.mock.calls[0][0];
    expect(firstPayload.scope).toBe('global');
    expect(firstPayload.businessId).toBe(GLOBAL_CATALOG_BUSINESS_ID);
    expect(firstPayload.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(stats.total).toBe(2);
    expect(stats.indexed).toBe(2);
  });
});

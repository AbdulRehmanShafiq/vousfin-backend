'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../services/embeddingService', () => ({ embedDocuments: jest.fn() }));
jest.mock('../../../services/vectorStore.service', () => ({ upsertEmbedding: jest.fn().mockResolvedValue({ upserted: true }) }));

const { GLOBAL_CATALOG_BUSINESS_ID } = require('../../../config/constants');
const embeddingService = require('../../../services/embeddingService');
const vectorStore = require('../../../services/vectorStore.service');
const svc = require('../../../services/helpCorpus.service');

const ENTRIES = [
  { id: 'sales.invoices', type: 'page', title: 'Invoices', path: ['Sales', 'Invoices'], href: '/sales/invoices', desc: 'Bills you send to customers', moduleKey: 'sales' },
  { id: 'sales.new-invoice', type: 'action', title: 'New Invoice', path: ['Sales', 'New Invoice'], href: '/sales/invoices/new', desc: 'Create and send a new invoice', moduleKey: 'sales' },
  { id: 'payroll.run-payroll', type: 'action', title: 'Run Payroll', path: ['Payroll', 'Run Payroll'], href: '/payroll/run', desc: 'Calculate take-home pay', moduleKey: 'payroll' },
];

beforeEach(() => {
  jest.clearAllMocks();
  embeddingService.embedDocuments.mockImplementation((arr) => Promise.resolve(arr.map(() => [0.1, 0.2, 0.3])));
});

describe('buildHelpDocs', () => {
  const docs = svc.buildHelpDocs(ENTRIES);
  const byId = (id) => docs.find((d) => d.id === id);

  it('titles a page how-to as "How to use X"', () => {
    expect(byId('help.sales.invoices').title).toBe('How to use Invoices');
  });
  it('titles a "New X" action naturally as "How to create a new x"', () => {
    expect(byId('help.sales.new-invoice').title).toBe('How to create a new invoice');
  });
  it('titles a verb action as "How to run payroll"', () => {
    expect(byId('help.payroll.run-payroll').title).toBe('How to run payroll');
  });
  it('includes the breadcrumb path and description in the body', () => {
    const body = byId('help.sales.invoices').body;
    expect(body).toMatch(/Bills you send to customers/);
    expect(body).toMatch(/Sales → Invoices/);
  });
  it('keeps the deep link and module on each doc', () => {
    expect(byId('help.sales.invoices')).toMatchObject({ href: '/sales/invoices', module: 'sales', type: 'page' });
  });
});

describe('serializeHelpDoc / parseHelpDoc roundtrip', () => {
  it('preserves frontmatter and body', () => {
    const [doc] = svc.buildHelpDocs(ENTRIES);
    const md = svc.serializeHelpDoc(doc);
    const parsed = svc.parseHelpDoc(md);
    expect(parsed).toMatchObject({ id: doc.id, title: doc.title, href: doc.href, module: doc.module, type: doc.type });
    expect(parsed.body.trim()).toBe(doc.body.trim());
  });

  it('parses CRLF files (git autocrlf rewrites the committed .md on checkout)', () => {
    const [doc] = svc.buildHelpDocs(ENTRIES);
    const crlf = svc.serializeHelpDoc(doc).replace(/\n/g, '\r\n');
    const parsed = svc.parseHelpDoc(crlf);
    expect(parsed.id).toBe(doc.id);
    expect(parsed.title).toBe(doc.title);
  });
});

describe('buildHelpVectorDocs', () => {
  it('maps a help doc to a GLOBAL-scope app_help vector payload', () => {
    const [doc] = svc.buildHelpDocs(ENTRIES);
    const [v] = svc.buildHelpVectorDocs([doc]);
    expect(v).toMatchObject({
      businessId: GLOBAL_CATALOG_BUSINESS_ID,
      scope: 'global',
      dataType: 'app_help',
      recordId: doc.id,
      period: 'static',
    });
    expect(v.summary).toMatch(/How to use Invoices/);
    expect(v.metadata).toMatchObject({ href: '/sales/invoices', title: 'How to use Invoices' });
  });
});

describe('reindexHelp', () => {
  it('embeds and upserts every help doc under the global scope', async () => {
    const docs = svc.buildHelpDocs(ENTRIES);
    const stats = await svc.reindexHelp({ docs });
    expect(embeddingService.embedDocuments).toHaveBeenCalledTimes(1);
    expect(vectorStore.upsertEmbedding).toHaveBeenCalledTimes(3);
    expect(vectorStore.upsertEmbedding.mock.calls[0][0].dataType).toBe('app_help');
    expect(stats.total).toBe(3);
  });
});

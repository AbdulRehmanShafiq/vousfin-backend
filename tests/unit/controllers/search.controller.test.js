'use strict';

jest.mock('../../../services/catalogSearch.service', () => ({ searchCatalog: jest.fn() }));
jest.mock('../../../services/appCatalogIndex.service', () => ({ reindexAppCatalog: jest.fn() }));
jest.mock('../../../services/helpCorpus.service', () => ({ reindexHelp: jest.fn() }));
jest.mock('../../../services/howTo.service', () => ({ answerHowTo: jest.fn() }));
jest.mock('../../../services/searchAnalytics.service', () => ({ logSearch: jest.fn(), getInsights: jest.fn() }));

const { searchCatalog } = require('../../../services/catalogSearch.service');
const appCatalogIndex = require('../../../services/appCatalogIndex.service');
const helpCorpus = require('../../../services/helpCorpus.service');
const { answerHowTo } = require('../../../services/howTo.service');
const searchAnalytics = require('../../../services/searchAnalytics.service');
const controller = require('../../../controllers/search.controller');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => jest.clearAllMocks());

describe('search.controller.catalogSearch', () => {
  it('passes query, limit and disabled modules to the service and returns results', async () => {
    searchCatalog.mockResolvedValue([{ id: 'sales.invoices', title: 'Invoices' }]);
    const req = { query: { q: 'invoices', limit: '5', disabled: 'payroll,planning' } };
    const res = mockRes();
    await controller.catalogSearch(req, res, jest.fn());

    expect(searchCatalog).toHaveBeenCalledWith('invoices', { disabledModules: ['payroll', 'planning'], limit: 5 });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ count: 1 }),
    }));
  });

  it('defaults limit to 8 and disabled to [] when omitted', async () => {
    searchCatalog.mockResolvedValue([]);
    await controller.catalogSearch({ query: { q: 'x' } }, mockRes(), jest.fn());
    expect(searchCatalog).toHaveBeenCalledWith('x', { disabledModules: [], limit: 8 });
  });

  it('forwards service errors to next()', async () => {
    const err = new Error('boom');
    searchCatalog.mockRejectedValue(err);
    const next = jest.fn();
    await controller.catalogSearch({ query: { q: 'x' } }, mockRes(), next);
    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('search.controller.howToSearch', () => {
  it('returns a grounded answer from the service', async () => {
    answerHowTo.mockResolvedValue({ grounded: true, answer: '1. Open Sales.', href: '/sales/invoices', sources: [{ href: '/sales/invoices' }] });
    const res = mockRes();
    await controller.howToSearch({ body: { q: 'how do i invoice' } }, res, jest.fn());
    expect(answerHowTo).toHaveBeenCalledWith('how do i invoice');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ grounded: true, href: '/sales/invoices' }),
    }));
  });

  it('short-circuits an empty query without calling the service', async () => {
    const res = mockRes();
    await controller.howToSearch({ body: { q: '  ' } }, res, jest.fn());
    expect(answerHowTo).not.toHaveBeenCalled();
  });
});

describe('search.controller.logSearch', () => {
  it('records the event scoped to the caller business and responds immediately', () => {
    const req = { user: { businessId: 'biz1' }, body: { kind: 'catalog', query: 'invoices', noResult: false } };
    const res = mockRes();
    controller.logSearch(req, res);
    expect(searchAnalytics.logSearch).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'biz1', query: 'invoices' }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

describe('search.controller.searchInsights', () => {
  it('returns insights for the caller business', async () => {
    searchAnalytics.getInsights.mockResolvedValue({ totals: { searches: 10, ctr: 70 }, topQueries: [], gaps: [] });
    const req = { user: { businessId: 'biz1' }, query: { days: '7' } };
    const res = mockRes();
    await controller.searchInsights(req, res, jest.fn());
    expect(searchAnalytics.getInsights).toHaveBeenCalledWith('biz1', { days: 7 });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ totals: expect.any(Object) }) }));
  });
});

describe('search.controller.reindexCatalog', () => {
  it('runs both the catalog and help reindex and returns combined stats', async () => {
    appCatalogIndex.reindexAppCatalog.mockResolvedValue({ total: 65, indexed: 65, skipped: 0 });
    helpCorpus.reindexHelp.mockResolvedValue({ total: 55, indexed: 55, skipped: 0 });
    const res = mockRes();
    await controller.reindexCatalog({}, res, jest.fn());
    expect(appCatalogIndex.reindexAppCatalog).toHaveBeenCalledTimes(1);
    expect(helpCorpus.reindexHelp).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        catalog: expect.objectContaining({ total: 65 }),
        help: expect.objectContaining({ total: 55 }),
      }),
    }));
  });
});

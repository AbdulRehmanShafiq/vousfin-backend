'use strict';

jest.mock('../../../services/catalogSearch.service', () => ({ searchCatalog: jest.fn() }));
jest.mock('../../../services/appCatalogIndex.service', () => ({ reindexAppCatalog: jest.fn() }));
jest.mock('../../../services/helpCorpus.service', () => ({ reindexHelp: jest.fn() }));

const { searchCatalog } = require('../../../services/catalogSearch.service');
const appCatalogIndex = require('../../../services/appCatalogIndex.service');
const helpCorpus = require('../../../services/helpCorpus.service');
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

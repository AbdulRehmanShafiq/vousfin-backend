'use strict';

const mockBusiness = { findById: jest.fn() };
jest.mock('mongoose', () => ({ model: () => mockBusiness, Types: { ObjectId: (v) => v } }));
jest.mock('../../../repositories/taxReturn.repository', () => ({ findById: jest.fn(), update: jest.fn() }));
jest.mock('../../../services/fbr/fbrClient.service', () => ({ submit: jest.fn() }));
jest.mock('../../../services/audit.service', () => ({ log: jest.fn() }));

const repo       = require('../../../repositories/taxReturn.repository');
const fbrClient  = require('../../../services/fbr/fbrClient.service');
const audit      = require('../../../services/audit.service');
const filing     = require('../../../services/returnFiling.service');

const BIZ = 'biz1';

function mockConfig(taxConfig = { filingMode: 'xml', taxRegistrationNumber: '1234567' }) {
  mockBusiness.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ taxConfig }) }) });
}
const validatedReturn = (over = {}) => ({ _id: 'r1', businessId: BIZ, returnType: 'GST-01', status: 'validated', period: { year: 2026, month: 6 }, data: {}, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig();
  repo.update.mockImplementation((id, u) => Promise.resolve({ _id: id, ...u.$set }));
  audit.log.mockResolvedValue({});
});

describe('returnFiling.submitReturn', () => {
  it('stores the IRIS ack, files the return, and writes an audit row', async () => {
    repo.findById.mockResolvedValue(validatedReturn());
    fbrClient.submit.mockResolvedValue({ mode: 'iris', ackNumber: 'FBR-ACK-1', xml: '<x/>' });

    const out = await filing.submitReturn(BIZ, 'r1', 'user1');
    expect(out.mode).toBe('iris');
    expect(out.ackNumber).toBe('FBR-ACK-1');
    expect(out.return.status).toBe('filed');
    expect(out.return['fbr.ackNumber']).toBe('FBR-ACK-1');
    // ack recorded in the audit trail (AC)
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      entityType: 'taxReturn', entityId: 'r1', action: 'Filed',
      afterState: expect.objectContaining({ ackNumber: 'FBR-ACK-1' }),
    }));
  });

  it('returns the XML for download on the fallback path without crashing', async () => {
    repo.findById.mockResolvedValue(validatedReturn());
    fbrClient.submit.mockResolvedValue({ mode: 'xml', xml: '<GSTReturn/>', fallbackReason: 'IRIS 503' });

    const out = await filing.submitReturn(BIZ, 'r1', 'user1');
    expect(out.mode).toBe('xml');
    expect(out.xml).toBe('<GSTReturn/>');
    expect(out.return.status).toBeUndefined();   // stays validated (no FILED transition)
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('refuses to file a return that is not yet validated', async () => {
    repo.findById.mockResolvedValue(validatedReturn({ status: 'draft' }));
    await expect(filing.submitReturn(BIZ, 'r1', 'u1')).rejects.toThrow(/validated/);
  });

  it('404s on another business’s return', async () => {
    repo.findById.mockResolvedValue(validatedReturn({ businessId: 'other' }));
    await expect(filing.submitReturn(BIZ, 'r1', 'u1')).rejects.toThrow(/not found/i);
  });
});

describe('returnFiling.exportReturn', () => {
  it('exports FBR XML with a sensible filename', async () => {
    repo.findById.mockResolvedValue(validatedReturn());
    const out = await filing.exportReturn(BIZ, 'r1', 'xml');
    expect(out.format).toBe('xml');
    expect(out.filename).toBe('GST-01-2026-06.xml');
    expect(out.content).toContain('<GSTReturn>');
  });
});

'use strict';

const fbrClient = require('../../../services/fbr/fbrClient.service');

const doc = { returnType: 'GST-01', period: { year: 2026, month: 6 }, data: { fields: { netPayable: 1000 }, annexes: { A: [], C: [] } } };

describe('fbrClient.submit', () => {
  it('returns FBR XML on the guaranteed path when filingMode is xml', async () => {
    const out = await fbrClient.submit(doc, { filingMode: 'xml', ntn: '1234567' });
    expect(out.mode).toBe('xml');
    expect(out.xml).toContain('<GSTReturn>');
    expect(out.ackNumber).toBeUndefined();
  });

  it('submits to IRIS and returns an ack number when configured', async () => {
    const transport = jest.fn().mockResolvedValue({ ackNumber: 'FBR-ACK-99' });
    const out = await fbrClient.submit(
      doc,
      { filingMode: 'iris', fbrCredentials: { irisToken: 'tok', ntn: '1234567' } },
      { irisTransport: transport },
    );
    expect(transport).toHaveBeenCalled();
    expect(out.mode).toBe('iris');
    expect(out.ackNumber).toBe('FBR-ACK-99');
    expect(out.xml).toContain('<GSTReturn>');
  });

  it('falls back to XML (never throws) when IRIS fails — graceful when FBR is unavailable', async () => {
    const transport = jest.fn().mockRejectedValue(new Error('IRIS 503'));
    const out = await fbrClient.submit(
      doc,
      { filingMode: 'iris', fbrCredentials: { irisToken: 'tok' } },
      { irisTransport: transport },
    );
    expect(out.mode).toBe('xml');
    expect(out.fallbackReason).toMatch(/503/);
    expect(out.xml).toContain('<GSTReturn>');
  });

  it('does not attempt IRIS without credentials even if filingMode is iris', async () => {
    const transport = jest.fn();
    const out = await fbrClient.submit(doc, { filingMode: 'iris', fbrCredentials: {} }, { irisTransport: transport });
    expect(transport).not.toHaveBeenCalled();
    expect(out.mode).toBe('xml');
  });
});

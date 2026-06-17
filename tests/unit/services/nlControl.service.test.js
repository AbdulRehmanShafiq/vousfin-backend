'use strict';

jest.mock('../../../services/autonomyPolicy.service', () => ({ setCapability: jest.fn() }));
jest.mock('../../../services/paymentsAgent.service', () => ({ setVendorHold: jest.fn() }));
jest.mock('../../../models/Vendor.model', () => ({ findOne: jest.fn() }), { virtual: true });

const policy = require('../../../services/autonomyPolicy.service');
const paymentsAgent = require('../../../services/paymentsAgent.service');
const Vendor = require('../../../models/Vendor.model');
const nl = require('../../../services/nlControl.service');

const BIZ = 'biz1';
const lean = (v) => ({ lean: () => Promise.resolve(v) });

beforeEach(() => {
  jest.clearAllMocks();
  policy.setCapability.mockResolvedValue({});
  paymentsAgent.setVendorHold.mockResolvedValue({});
  Vendor.findOne.mockReturnValue(lean({ _id: 'v1', vendorName: 'ACME Ltd' }));
});

describe('dial commands', () => {
  it('"set tax to autopilot" → Tax = autopilot', async () => {
    const r = await nl.interpret(BIZ, 'set tax to autopilot', { id: 'u1' });
    expect(policy.setCapability).toHaveBeenCalledWith(BIZ, 'tax', { level: 'autopilot' }, 'u1');
    expect(r).toMatchObject({ understood: true, kind: 'dial', data: { capability: 'tax', level: 'autopilot' } });
    expect(r.message).toMatch(/Tax is now on Autopilot/i);
  });

  it('understands synonyms ("raise chasing to co-pilot")', async () => {
    const r = await nl.interpret(BIZ, 'raise chasing to co-pilot', {});
    expect(policy.setCapability).toHaveBeenCalledWith(BIZ, 'collections', { level: 'copilot' }, null);
    expect(r.understood).toBe(true);
  });

  it('asks which area when only a level is given', async () => {
    const r = await nl.interpret(BIZ, 'turn it to autopilot', {});
    expect(r.understood).toBe(false);
    expect(r.message).toMatch(/which area/i);
    expect(policy.setCapability).not.toHaveBeenCalled();
  });

  it('asks how much when only a capability is given', async () => {
    const r = await nl.interpret(BIZ, 'change payments please', {});
    expect(r.understood).toBe(false);
    expect(r.message).toMatch(/how much should Payments act/i);
  });
});

describe('payment hold / release', () => {
  it('"don\'t pay ACME" → holds the vendor', async () => {
    const r = await nl.interpret(BIZ, "don't pay ACME for now", { id: 'u1' });
    expect(Vendor.findOne).toHaveBeenCalled();
    expect(paymentsAgent.setVendorHold).toHaveBeenCalledWith(BIZ, 'v1', true);
    expect(r).toMatchObject({ understood: true, kind: 'payment_hold' });
    expect(r.message).toMatch(/won't propose paying ACME Ltd/i);
  });

  it('"you can pay ACME again" → releases the hold', async () => {
    const r = await nl.interpret(BIZ, 'you can pay ACME again', {});
    expect(paymentsAgent.setVendorHold).toHaveBeenCalledWith(BIZ, 'v1', false);
    expect(r).toMatchObject({ understood: true, kind: 'payment_release' });
  });

  it('reports when the vendor is not found', async () => {
    Vendor.findOne.mockReturnValue(lean(null));
    const r = await nl.interpret(BIZ, 'stop paying Nonesuch', {});
    expect(r.understood).toBe(false);
    expect(r.message).toMatch(/couldn't find a vendor/i);
    expect(paymentsAgent.setVendorHold).not.toHaveBeenCalled();
  });

  it('does not treat a "payments" dial change as a hold', async () => {
    const r = await nl.interpret(BIZ, 'set payments to suggest', {});
    expect(paymentsAgent.setVendorHold).not.toHaveBeenCalled();
    expect(policy.setCapability).toHaveBeenCalledWith(BIZ, 'payments', { level: 'suggest' }, null);
    expect(r.understood).toBe(true);
  });
});

describe('unparseable input', () => {
  it('asks for a clearer command', async () => {
    const r = await nl.interpret(BIZ, 'hello there', {});
    expect(r.understood).toBe(false);
    expect(r.message).toMatch(/didn't quite catch/i);
  });
});

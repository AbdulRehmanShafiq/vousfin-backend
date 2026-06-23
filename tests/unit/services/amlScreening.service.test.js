// tests/unit/services/amlScreening.service.test.js — FR-10.3
'use strict';

jest.mock('../../../models/CounterpartyScreening.model', () => ({
  findOneAndUpdate: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
}));

const CounterpartyScreening = require('../../../models/CounterpartyScreening.model');
const amlService = require('../../../services/amlScreening.service');

beforeEach(() => jest.clearAllMocks());

const BIZ = 'biz001';

describe('screenCounterparty', () => {
  it('flags a name containing a risk keyword', async () => {
    CounterpartyScreening.findOneAndUpdate.mockResolvedValue({
      result: 'flagged', flags: ['KEYWORD_CASH'], riskScore: 15,
    });

    await amlService.screenCounterparty(BIZ, {
      counterpartyType: 'customer',
      counterpartyId: 'cust1',
      counterpartyName: 'Cash Traders Ltd',
    });

    const call = CounterpartyScreening.findOneAndUpdate.mock.calls[0];
    const update = call[1].$set;
    expect(update.flags).toContain('KEYWORD_CASH');
    expect(update.riskScore).toBeGreaterThanOrEqual(15);
  });

  it('adds HIGH_VALUE_TRANSACTION flag for transactions >= 500000', async () => {
    CounterpartyScreening.findOneAndUpdate.mockResolvedValue({ result: 'flagged', flags: ['HIGH_VALUE_TRANSACTION'], riskScore: 20 });

    await amlService.screenCounterparty(BIZ, {
      counterpartyType: 'vendor',
      counterpartyId: 'vend1',
      counterpartyName: 'Regular Supplier',
      transactionAmount: 600000,
    });

    const update = CounterpartyScreening.findOneAndUpdate.mock.calls[0][1].$set;
    expect(update.flags).toContain('HIGH_VALUE_TRANSACTION');
    expect(update.riskScore).toBeGreaterThanOrEqual(20);
  });

  it('sets result to clear for a low-risk name with no keywords', async () => {
    CounterpartyScreening.findOneAndUpdate.mockResolvedValue({ result: 'clear', flags: [], riskScore: 0 });

    await amlService.screenCounterparty(BIZ, {
      counterpartyType: 'customer',
      counterpartyId: 'cust2',
      counterpartyName: 'Sunrise Bakers',
    });

    const update = CounterpartyScreening.findOneAndUpdate.mock.calls[0][1].$set;
    expect(update.result).toBe('clear');
    expect(update.riskScore).toBe(0);
    expect(update.flags).toHaveLength(0);
  });

  it('does not add HIGH_VALUE_TRANSACTION flag below threshold', async () => {
    CounterpartyScreening.findOneAndUpdate.mockResolvedValue({ result: 'clear', flags: [], riskScore: 0 });

    await amlService.screenCounterparty(BIZ, {
      counterpartyType: 'customer',
      counterpartyId: 'cust3',
      counterpartyName: 'Good Customer',
      transactionAmount: 499999,
    });

    const update = CounterpartyScreening.findOneAndUpdate.mock.calls[0][1].$set;
    expect(update.flags).not.toContain('HIGH_VALUE_TRANSACTION');
  });
});

describe('draftSTR', () => {
  it('returns the correct STR draft shape without a DB write', async () => {
    const screeningDate = new Date('2026-06-15');
    CounterpartyScreening.findOne.mockResolvedValue({
      _id: 'scr1',
      businessId: BIZ,
      counterpartyName: 'Shell Holdings',
      flags: ['KEYWORD_SHELL'],
      riskScore: 15,
      screeningDate,
    });

    const draft = await amlService.draftSTR('scr1', BIZ);

    expect(draft).toHaveProperty('draftText');
    expect(draft.draftText).toContain('Shell Holdings');
    expect(draft.draftText).toContain('KEYWORD_SHELL');
    expect(draft.draftText).toContain('15');
    expect(CounterpartyScreening.findOneAndUpdate).not.toHaveBeenCalled(); // no write
  });

  it('throws 404 if screening not found', async () => {
    CounterpartyScreening.findOne.mockResolvedValue(null);
    await expect(amlService.draftSTR('nope', BIZ)).rejects.toMatchObject({ statusCode: 404 });
  });
});

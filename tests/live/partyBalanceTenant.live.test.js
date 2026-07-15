/**
 * tests/live/partyBalanceTenant.live.test.js
 *
 * Party-balance updates were keyed on _id alone (audit 2026-07-02 P3), so a
 * wrong-tenant customerId reaching adjustReceivable would silently move ANOTHER
 * business's receivable. Defence in depth: the caller always knows the business,
 * so the query says so.
 *
 * Live tier because "the update did not touch the other tenant's row" is a claim
 * about a real database — a mocked repository would happily agree either way.
 */
'use strict';

const { startLiveDb, stopLiveDb, resetDb, seedBusiness } = require('./harness');

jest.setTimeout(120000);

const partyBalanceService = require('../../services/partyBalance.service');
const Customer = require('../../models/Customer.model');
const Vendor = require('../../models/Vendor.model');

let mine;
let theirs;

beforeAll(startLiveDb);
afterAll(stopLiveDb);
beforeEach(async () => {
  await resetDb();
  mine = await seedBusiness({ name: 'My Co' });
  theirs = await seedBusiness({ name: 'Their Co' });
});

describe('adjustReceivable', () => {
  it('moves my own customer’s balance', async () => {
    const c = await Customer.create({
      businessId: mine.business._id, fullName: 'A Customer', currentReceivableBalance: 0,
    });

    await partyBalanceService.adjustReceivable(mine.businessId, c._id, 500, { reason: 'credit_sale' });

    expect((await Customer.findById(c._id).lean()).currentReceivableBalance).toBe(500);
  });

  it('refuses to move a customer that belongs to another business', async () => {
    const notMine = await Customer.create({
      businessId: theirs.business._id, fullName: 'Their Customer', currentReceivableBalance: 100,
    });

    // My business, their customer's id. Keyed on _id alone this silently
    // succeeded and moved their books.
    await expect(
      partyBalanceService.adjustReceivable(mine.businessId, notMine._id, 500, { reason: 'credit_sale' })
    ).rejects.toThrow(/not found/i);

    expect((await Customer.findById(notMine._id).lean()).currentReceivableBalance).toBe(100);
  });
});

describe('adjustPayable', () => {
  it('refuses to move a vendor that belongs to another business', async () => {
    const notMine = await Vendor.create({
      businessId: theirs.business._id, vendorName: 'Their Vendor', currentPayableBalance: 250,
    });

    await expect(
      partyBalanceService.adjustPayable(mine.businessId, notMine._id, 900, { reason: 'credit_purchase' })
    ).rejects.toThrow(/not found/i);

    expect((await Vendor.findById(notMine._id).lean()).currentPayableBalance).toBe(250);
  });
});

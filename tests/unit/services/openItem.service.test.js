/**
 * tests/unit/services/openItem.service.test.js
 *
 * Audit 2026-07-02 F3 — one shared adjuster for the open-item balance carried
 * on an AR/AP recognition JOURNAL ENTRY.
 *
 * Credit notes, vendor credits and write-offs adjusted the Invoice/Bill
 * DOCUMENT, the GL and the party balance — but never the linked recognition
 * JE's remainingBalance. The payment engine validates against the JE, the
 * aging report reads the JE, and the VE-5 subledger reconcile sums the JE —
 * so a fully-credited invoice could still be collected in full, aging was
 * overstated, and the integrity gate drifted. Every credit-shaped adjustment
 * now flows through openItemService.adjustOpenItem.
 */
'use strict';

jest.mock('../../../models/JournalEntry.model', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const JournalEntry = require('../../../models/JournalEntry.model');
const openItemService = require('../../../services/openItem.service');
const { JOURNAL_STATUS, PAYMENT_STATUS } = require('../../../config/constants');

const BIZ = 'biz1';
const JE_ID = 'je1';

const mockRead = (je) => {
  JournalEntry.findOne.mockReturnValue({
    session: () => ({ lean: () => Promise.resolve(je) }),
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  JournalEntry.findOneAndUpdate.mockResolvedValue({ _id: JE_ID });
});

describe('openItemService.adjustOpenItem', () => {
  test('reduces the open balance and settles it when fully credited', async () => {
    mockRead({ _id: JE_ID, remainingBalance: 400, partiallyPaidAmount: 0, status: JOURNAL_STATUS.POSTED, dueDate: null });

    await openItemService.adjustOpenItem(BIZ, JE_ID, -400, { session: 'S' });

    expect(JournalEntry.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: JE_ID, businessId: BIZ, remainingBalance: 400 }, // optimistic guard on what we read
      expect.objectContaining({
        remainingBalance: 0,
        paymentStatus: PAYMENT_STATUS.PAID,
        status: JOURNAL_STATUS.SETTLED,
      }),
      expect.objectContaining({ session: 'S' })
    );
  });

  test('a partial credit keeps the entry open with the reduced balance', async () => {
    mockRead({ _id: JE_ID, remainingBalance: 1000, partiallyPaidAmount: 0, status: JOURNAL_STATUS.POSTED, dueDate: null });

    await openItemService.adjustOpenItem(BIZ, JE_ID, -400, { session: null });

    expect(JournalEntry.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ remainingBalance: 1000 }),
      expect.objectContaining({
        remainingBalance: 600,
        paymentStatus: PAYMENT_STATUS.UNPAID,
        status: JOURNAL_STATUS.POSTED,
      }),
      expect.any(Object)
    );
  });

  test('a positive delta reopens a settled entry (credit-note cancel)', async () => {
    mockRead({ _id: JE_ID, remainingBalance: 0, partiallyPaidAmount: 600, status: JOURNAL_STATUS.SETTLED, dueDate: null });

    await openItemService.adjustOpenItem(BIZ, JE_ID, 400, { session: 'S' });

    expect(JournalEntry.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ remainingBalance: 0 }),
      expect.objectContaining({
        remainingBalance: 400,
        paymentStatus: PAYMENT_STATUS.PARTIALLY_PAID,
        status: JOURNAL_STATUS.PARTIALLY_SETTLED,
      }),
      expect.any(Object)
    );
  });

  test('no-ops (returns null) when the entry does not track an open balance', async () => {
    mockRead({ _id: JE_ID, remainingBalance: null, status: JOURNAL_STATUS.POSTED });

    const res = await openItemService.adjustOpenItem(BIZ, JE_ID, -100, {});

    expect(res).toBeNull();
    expect(JournalEntry.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('no-ops when the journal id is missing or the entry is reversed', async () => {
    expect(await openItemService.adjustOpenItem(BIZ, null, -100, {})).toBeNull();

    mockRead({ _id: JE_ID, remainingBalance: 500, status: JOURNAL_STATUS.REVERSED });
    expect(await openItemService.adjustOpenItem(BIZ, JE_ID, -100, {})).toBeNull();
    expect(JournalEntry.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('over-credit clamps at zero, never negative', async () => {
    mockRead({ _id: JE_ID, remainingBalance: 100, partiallyPaidAmount: 0, status: JOURNAL_STATUS.POSTED, dueDate: null });

    await openItemService.adjustOpenItem(BIZ, JE_ID, -250, {});

    expect(JournalEntry.findOneAndUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ remainingBalance: 0 }),
      expect.any(Object)
    );
  });

  test('throws 409 when the optimistic guard misses (concurrent settlement)', async () => {
    mockRead({ _id: JE_ID, remainingBalance: 400, partiallyPaidAmount: 0, status: JOURNAL_STATUS.POSTED, dueDate: null });
    JournalEntry.findOneAndUpdate.mockResolvedValue(null);

    await expect(openItemService.adjustOpenItem(BIZ, JE_ID, -400, {}))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});

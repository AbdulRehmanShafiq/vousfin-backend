'use strict';
jest.mock('../../../models/SupportTicket.model');
const SupportTicket = require('../../../models/SupportTicket.model');
const supportService = require('../../../services/support.service');

const makeTicket = (overrides = {}) => ({
  _id: 't1',
  userId: 'u1',
  subject: 'My issue',
  status: 'open',
  messages: [],
  save: jest.fn().mockResolvedValue({ _id: 't1', status: 'in_progress' }),
  ...overrides,
});

describe('SupportService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('createTicket', () => {
    it('creates ticket with first user message', async () => {
      const ticket = makeTicket({ messages: [{ from: 'user', authorId: 'u1', body: 'Hello' }] });
      SupportTicket.create = jest.fn().mockResolvedValue(ticket);

      const actor = { id: 'u1', businessId: 'b1', fullName: 'Bob', email: 'b@b.com' };
      const result = await supportService.createTicket(actor, { subject: 'My issue', category: 'question', priority: 'normal', message: 'Hello' });

      expect(SupportTicket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          messages: expect.arrayContaining([expect.objectContaining({ from: 'user', body: 'Hello' })]),
        }),
      );
      expect(result.messages[0].from).toBe('user');
    });
  });

  describe('addUserReply', () => {
    it('blocks non-owner', async () => {
      const ticket = makeTicket({ userId: 'u1' });
      SupportTicket.findById = jest.fn().mockResolvedValue(ticket);
      await expect(supportService.addUserReply('t1', 'u2', 'hello')).rejects.toMatchObject({ statusCode: 403 });
    });

    it('adds reply from owner', async () => {
      const ticket = makeTicket({ userId: 'u1', messages: [], status: 'open' });
      SupportTicket.findById = jest.fn().mockResolvedValue(ticket);

      await supportService.addUserReply('t1', 'u1', 'follow-up');
      expect(ticket.messages).toHaveLength(1);
      expect(ticket.save).toHaveBeenCalled();
    });
  });

  describe('addAdminReply', () => {
    it('sets status to in_progress when ticket is open', async () => {
      const ticket = makeTicket({ status: 'open', messages: [] });
      SupportTicket.findById = jest.fn().mockResolvedValue(ticket);
      await supportService.addAdminReply('t1', 'admin1', 'Looking into it');
      expect(ticket.status).toBe('in_progress');
      expect(ticket.save).toHaveBeenCalled();
    });
  });

  describe('updateTicket', () => {
    it('changes ticket status', async () => {
      const updated = makeTicket({ status: 'resolved' });
      SupportTicket.findByIdAndUpdate = jest.fn().mockResolvedValue(updated);
      const result = await supportService.updateTicket('t1', { status: 'resolved' });
      expect(result.status).toBe('resolved');
    });
  });
});

'use strict';
jest.mock('../../../models/Feedback.model');
const Feedback = require('../../../models/Feedback.model');
const userFeedbackService = require('../../../services/userFeedback.service');

describe('UserFeedbackService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('submit', () => {
    it('creates feedback enriched with actor info', async () => {
      const created = { _id: 'f1', message: 'Great app', userId: 'u1' };
      Feedback.create = jest.fn().mockResolvedValue(created);

      const actor = { id: 'u1', businessId: 'b1', fullName: 'Alice', email: 'a@a.com' };
      const result = await userFeedbackService.submit({ message: 'Great app' }, actor);

      expect(Feedback.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', businessId: 'b1', name: 'Alice', email: 'a@a.com' }),
      );
      expect(result).toEqual(created);
    });

    it('creates feedback without actor when not logged in', async () => {
      Feedback.create = jest.fn().mockResolvedValue({ _id: 'f2' });
      await userFeedbackService.submit({ message: 'Bug report' });
      expect(Feedback.create).toHaveBeenCalledWith(expect.objectContaining({ message: 'Bug report' }));
    });
  });

  describe('listAll', () => {
    it('filters by status', async () => {
      const mockFind = { sort: jest.fn().mockReturnThis(), skip: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) };
      Feedback.find = jest.fn().mockReturnValue(mockFind);
      Feedback.countDocuments = jest.fn().mockResolvedValue(0);

      const result = await userFeedbackService.listAll({ status: 'new' });

      expect(Feedback.find).toHaveBeenCalledWith({ status: 'new' });
      expect(result).toMatchObject({ data: [], total: 0, page: 1, limit: 50 });
    });
  });

  describe('updateStatus', () => {
    it('throws 404 if feedback not found', async () => {
      Feedback.findByIdAndUpdate = jest.fn().mockResolvedValue(null);
      await expect(userFeedbackService.updateStatus('bad-id', { status: 'reviewed' })).rejects.toMatchObject({ statusCode: 404 });
    });

    it('updates feedback status', async () => {
      const updated = { _id: 'f1', status: 'reviewed' };
      Feedback.findByIdAndUpdate = jest.fn().mockResolvedValue(updated);
      const result = await userFeedbackService.updateStatus('f1', { status: 'reviewed' });
      expect(result.status).toBe('reviewed');
    });
  });
});

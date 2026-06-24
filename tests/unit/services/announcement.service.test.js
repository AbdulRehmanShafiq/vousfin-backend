'use strict';
jest.mock('../../../models/Announcement.model');
const Announcement = require('../../../models/Announcement.model');
const announcementService = require('../../../services/announcement.service');

describe('AnnouncementService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('listActive', () => {
    it('excludes inactive and expired announcements', async () => {
      const mockFind = { sort: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([{ title: 'Active one' }]) };
      Announcement.find = jest.fn().mockReturnValue(mockFind);

      const result = await announcementService.listActive();

      const query = Announcement.find.mock.calls[0][0];
      expect(query.active).toBe(true);
      expect(query.$or).toBeDefined();
      expect(result).toHaveLength(1);
    });
  });

  describe('create', () => {
    it('sets createdBy from actor', async () => {
      const doc = { _id: 'a1', title: 'Test', createdBy: 'admin1' };
      Announcement.create = jest.fn().mockResolvedValue(doc);

      const result = await announcementService.create({ title: 'Test', body: 'Body' }, { id: 'admin1' });

      expect(Announcement.create).toHaveBeenCalledWith(
        expect.objectContaining({ createdBy: 'admin1' }),
      );
      expect(result.createdBy).toBe('admin1');
    });
  });
});

// tests/unit/utils/ApiResponse.test.js
const ApiResponse = require('../../../utils/ApiResponse');

// Create a minimal mock for Express response object
const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res;
};

describe('ApiResponse', () => {
  describe('success()', () => {
    test('should return 200 with success true and data', () => {
      const res = mockRes();
      ApiResponse.success(res, { id: 1 }, 'OK');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'OK',
        data: { id: 1 },
      });
    });

    test('should default message to "Success" and data to null', () => {
      const res = mockRes();
      ApiResponse.success(res);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, message: 'Success', data: null })
      );
    });

    test('should use custom statusCode when provided', () => {
      const res = mockRes();
      ApiResponse.success(res, null, 'Accepted', 202);
      expect(res.status).toHaveBeenCalledWith(202);
    });
  });

  describe('error()', () => {
    test('should return 500 with success false by default', () => {
      const res = mockRes();
      ApiResponse.error(res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, data: null })
      );
    });

    test('should use provided statusCode and message', () => {
      const res = mockRes();
      ApiResponse.error(res, 'Not found', 404);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, message: 'Not found' })
      );
    });
  });

  describe('created()', () => {
    test('should return 201 with success true', () => {
      const res = mockRes();
      ApiResponse.created(res, { id: 99 }, 'Created');
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, data: { id: 99 } })
      );
    });
  });

  describe('noContent()', () => {
    test('should return 204 with no body', () => {
      const res = mockRes();
      ApiResponse.noContent(res);
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
    });
  });
});

// tests/unit/utils/ApiError.test.js
const ApiError = require('../../../utils/ApiError');

describe('ApiError', () => {
  test('should create an error with correct statusCode and message', () => {
    const err = new ApiError(404, 'Not Found');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('Not Found');
  });

  test('should set status to "fail" for 4xx errors', () => {
    const err = new ApiError(400, 'Bad Request');
    expect(err.status).toBe('fail');
  });

  test('should set status to "error" for 5xx errors', () => {
    const err = new ApiError(500, 'Internal Server Error');
    expect(err.status).toBe('error');
  });

  test('should default isOperational to true', () => {
    const err = new ApiError(401, 'Unauthorized');
    expect(err.isOperational).toBe(true);
  });

  test('should allow setting isOperational to false', () => {
    const err = new ApiError(500, 'System Error', false);
    expect(err.isOperational).toBe(false);
  });

  test('should capture stack trace', () => {
    const err = new ApiError(400, 'Test');
    expect(err.stack).toBeDefined();
  });

  test('should be importable both as default and named export', () => {
    const DefaultExport = require('../../../utils/ApiError');
    const { ApiError: NamedExport } = require('../../../utils/ApiError');
    expect(new DefaultExport(400, 'test')).toBeInstanceOf(Error);
    expect(new NamedExport(400, 'test')).toBeInstanceOf(Error);
  });

  test('should handle different 4xx status codes', () => {
    [400, 401, 403, 404, 409, 422, 429].forEach(code => {
      const err = new ApiError(code, 'Client Error');
      expect(err.status).toBe('fail');
    });
  });
});

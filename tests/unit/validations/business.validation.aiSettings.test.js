// tests/unit/validations/business.validation.aiSettings.test.js
'use strict';
const { updateBusinessSchema } = require('../../../validations/business.validation');

describe('updateBusinessSchema — aiSettings.autoPostEnabled', () => {
  test('accepts { aiSettings: { autoPostEnabled: true } }', () => {
    const { error, value } = updateBusinessSchema.validate({ aiSettings: { autoPostEnabled: true } });
    expect(error).toBeUndefined();
    expect(value.aiSettings.autoPostEnabled).toBe(true);
  });

  test('rejects a non-boolean autoPostEnabled', () => {
    const { error } = updateBusinessSchema.validate({ aiSettings: { autoPostEnabled: 'yes' } });
    expect(error).toBeDefined();
  });

  test('rejects unknown keys inside aiSettings (no silent field smuggling)', () => {
    const { error } = updateBusinessSchema.validate({ aiSettings: { autoPostEnabled: true, somethingElse: 1 } });
    expect(error).toBeDefined();
  });
});

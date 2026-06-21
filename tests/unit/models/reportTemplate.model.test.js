const ReportTemplate = require('../../../models/ReportTemplate.model');

describe('ReportTemplate model', () => {
  test('requires businessId and name; defaults baseType to custom', () => {
    const t = new ReportTemplate({ businessId: '5f9d88b9c1234a0017a1b111', name: 'My P&L' });
    const err = t.validateSync();
    expect(err).toBeUndefined();
    expect(t.baseType).toBe('custom');
    expect(t.comparative.enabled).toBe(false);
    expect(t.schedule.enabled).toBe(false);
  });

  test('rejects an invalid baseType', () => {
    const t = new ReportTemplate({ businessId: '5f9d88b9c1234a0017a1b111', name: 'X', baseType: 'nope' });
    expect(t.validateSync()).toBeDefined();
  });
});

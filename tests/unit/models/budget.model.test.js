// tests/unit/models/budget.model.test.js
'use strict';
const Budget = require('../../../models/Budget.model');

describe('Budget model', () => {
  test('canTransition follows BUDGET_STATUS_TRANSITIONS', () => {
    expect(Budget.canTransition('draft', 'pending_approval')).toBe(true);
    expect(Budget.canTransition('pending_approval', 'active')).toBe(true);
    expect(Budget.canTransition('pending_approval', 'rejected')).toBe(true);
    expect(Budget.canTransition('active', 'draft')).toBe(false);
    expect(Budget.canTransition('archived', 'active')).toBe(false);
  });

  test('defaults: scenario=base, version=1, status=draft, defaultThresholdPct=10', () => {
    const b = new Budget({ businessId: '64b000000000000000000001', name: 'X',
      fiscalYearId: '64b000000000000000000002', createdBy: '64b000000000000000000003' });
    expect(b.scenario).toBe('base');
    expect(b.version).toBe(1);
    expect(b.status).toBe('draft');
    expect(b.defaultThresholdPct).toBe(10);
  });
});

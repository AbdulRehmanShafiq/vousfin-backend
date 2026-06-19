// tests/unit/models/job.model.test.js
'use strict';
const Job = require('../../../models/Job.model');
describe('Job model', () => {
  test('canTransition follows JOB_STATUS_TRANSITIONS', () => {
    expect(Job.canTransition('open', 'in_progress')).toBe(true);
    expect(Job.canTransition('in_progress', 'completed')).toBe(true);
    expect(Job.canTransition('completed', 'open')).toBe(false);
    expect(Job.canTransition('cancelled', 'in_progress')).toBe(false);
  });
  test('defaults: status=open, zeroed standardCost, empty costSheet', () => {
    const j = new Job({ businessId: '64b000000000000000000001', code: 'J1', name: 'X',
      createdBy: '64b000000000000000000002' });
    expect(j.status).toBe('open');
    expect(j.standardCost.material).toBe(0);
    expect(j.costSheet).toHaveLength(0);
  });
});

const { permissionsFor, can } = require('../../../utils/permissions');

describe('permissions helper', () => {
  test('owner resolves to wildcard (all permissions)', () => {
    const set = permissionsFor(['owner']);
    expect(set.has('*')).toBe(true);
    expect(can(set, 'anything:at:all')).toBe(true);
  });
  test('accountant can create + view but not approve', () => {
    expect(can(['accountant'], 'transaction:create')).toBe(true);
    expect(can(['accountant'], 'report:view')).toBe(true);
    expect(can(['accountant'], 'transaction:approve')).toBe(false);
    expect(can(['accountant'], 'member:manage')).toBe(false);
  });
  test('approver can approve + view but not create', () => {
    expect(can(['approver'], 'transaction:approve')).toBe(true);
    expect(can(['approver'], 'transaction:create')).toBe(false);
  });
  test('viewer is read-only', () => {
    expect(can(['viewer'], 'report:view')).toBe(true);
    expect(can(['viewer'], 'transaction:create')).toBe(false);
  });
  test('multiple roles union their permissions', () => {
    expect(can(['accountant', 'approver'], 'transaction:create')).toBe(true);
    expect(can(['accountant', 'approver'], 'transaction:approve')).toBe(true);
  });
  test('unknown role contributes nothing', () => {
    expect(can(['nope'], 'report:view')).toBe(false);
  });
});

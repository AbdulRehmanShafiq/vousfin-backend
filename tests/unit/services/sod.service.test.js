jest.mock('../../../models/SodRule.model');
const SodRule = require('../../../models/SodRule.model');
const service = require('../../../services/sod.service');

// service chains SodRule.find(...).lean() — mock find to return a chainable.
const mockRules = (arr) => SodRule.find.mockReturnValue({ lean: () => Promise.resolve(arr) });

beforeEach(() => jest.clearAllMocks());

describe('sod.service.checkRoleAssignment', () => {
  test('blocks accountant + approver by the built-in default', async () => {
    mockRules([]); // no custom rules → defaults apply
    await expect(service.checkRoleAssignment('b1', ['accountant', 'approver']))
      .rejects.toThrow(/segregation|same person|accountant/i);
  });

  test('allows a single role', async () => {
    mockRules([]);
    await expect(service.checkRoleAssignment('b1', ['accountant'])).resolves.toBeUndefined();
  });

  test('allows a non-conflicting pair (viewer + approver)', async () => {
    mockRules([]);
    await expect(service.checkRoleAssignment('b1', ['viewer', 'approver'])).resolves.toBeUndefined();
  });

  test('order does not matter (approver + accountant also blocked)', async () => {
    mockRules([]);
    await expect(service.checkRoleAssignment('b1', ['approver', 'accountant'])).rejects.toThrow();
  });

  test('custom rules replace the defaults', async () => {
    // business defined its own conflict (owner+approver); accountant+approver is now allowed
    mockRules([{ roleA: 'approver', roleB: 'owner', isActive: true }]);
    await expect(service.checkRoleAssignment('b1', ['accountant', 'approver'])).resolves.toBeUndefined();
    await expect(service.checkRoleAssignment('b1', ['owner', 'approver'])).rejects.toThrow();
  });
});

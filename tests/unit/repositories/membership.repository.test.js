const repo = require('../../../repositories/membership.repository');

describe('membership.repository', () => {
  test('exposes the expected query methods', () => {
    for (const m of ['findByBusinessAndUser','findActiveByBusinessAndUser','findOwnedByBusiness','findByInviteToken','findByBusinessAndEmail','countActiveOwners']) {
      expect(typeof repo[m]).toBe('function');
    }
  });
  test('countActiveOwners builds an active+owner query', async () => {
    const spy = jest.spyOn(repo.model, 'countDocuments').mockResolvedValue(2);
    const n = await repo.countActiveOwners('biz1');
    expect(n).toBe(2);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'biz1', status: 'active', roles: 'owner' }));
    spy.mockRestore();
  });
});

const { DEFAULT_ACCOUNTS } = require('../../../config/constants');

test('GRNI account 2115 is a default', () => {
  const grni = DEFAULT_ACCOUNTS.find(a => a.accountCode === '2115');
  expect(grni).toBeDefined();
  expect(grni).toMatchObject({
    accountName: 'Goods Received Not Invoiced',
    accountType: 'Liability', normalBalance: 'Credit', isDefault: true,
  });
});

test('all default account codes are unique', () => {
  const codes = DEFAULT_ACCOUNTS.map(a => a.accountCode);
  expect(new Set(codes).size).toBe(codes.length);
});

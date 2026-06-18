'use strict';
const { buildBankTransferCsv } = require('../../../utils/bankTransferFile.util');

describe('buildBankTransferCsv', () => {
  const run = { period: '2026-06' };

  it('emits a header row and one line per employee with net pay', () => {
    const csv = buildBankTransferCsv(run, [
      { bankAccountTitle: 'Ali Khan', iban: 'PK001', netPay: 139350 },
      { bankAccountTitle: 'Sara M', iban: 'PK002', netPay: 50000 },
    ]);
    const rows = csv.trim().split('\n');
    expect(rows[0]).toMatch(/Account Title,IBAN,Amount,Reference/);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toBe('Ali Khan,PK001,139350,Salary 2026-06');
  });

  it('escapes commas in account titles', () => {
    const csv = buildBankTransferCsv(run, [{ bankAccountTitle: 'Khan, Ali', iban: 'PK001', netPay: 100 }]);
    expect(csv).toContain('"Khan, Ali",PK001,100,Salary 2026-06');
  });
});

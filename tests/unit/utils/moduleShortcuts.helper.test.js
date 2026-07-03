'use strict';
const { rankShortcuts } = require('../../../utils/moduleShortcuts.helper');

const now = Date.now();
const ago = (mins) => new Date(now - mins * 60000);

describe('rankShortcuts', () => {
  it('ranks by usage, with recency breaking ties, capped at the limit', () => {
    const usages = [
      { moduleKey: 'invoices', label: 'Invoices', path: '/sales/invoices', count: 10, lastUsedAt: ago(600) },
      { moduleKey: 'bills',    label: 'Bills',    path: '/purchases/bills', count: 3,  lastUsedAt: ago(5) },
      { moduleKey: 'reports',  label: 'Reports',  path: '/reports', count: 3,  lastUsedAt: ago(500) },
      { moduleKey: 'tax',      label: 'Tax',      path: '/tax', count: 1, lastUsedAt: ago(2) },
      { moduleKey: 'payroll',  label: 'Payroll',  path: '/payroll', count: 1, lastUsedAt: ago(9000) },
      { moduleKey: 'budgets',  label: 'Budgets',  path: '/budgets', count: 1, lastUsedAt: ago(99999) },
    ];
    const r = rankShortcuts(usages, { limit: 4 });
    expect(r).toHaveLength(4);
    expect(r[0].moduleKey).toBe('invoices');           // highest count
    expect(r[1].moduleKey).toBe('bills');              // tie 3/3 → more recent wins
    expect(r[2].moduleKey).toBe('reports');
    expect(r.map((x) => x.moduleKey)).not.toContain('budgets'); // pushed out
  });

  it('defaults to a max of 5', () => {
    const usages = Array.from({ length: 8 }, (_, i) => ({ moduleKey: `m${i}`, label: `M${i}`, path: `/m${i}`, count: 8 - i, lastUsedAt: ago(i) }));
    expect(rankShortcuts(usages)).toHaveLength(5);
  });

  it('returns only the display fields (no internal counters leak)', () => {
    const r = rankShortcuts([{ moduleKey: 'invoices', label: 'Invoices', path: '/sales/invoices', count: 2, lastUsedAt: ago(1) }]);
    expect(r[0]).toEqual({ moduleKey: 'invoices', label: 'Invoices', path: '/sales/invoices' });
  });

  it('handles empty input', () => {
    expect(rankShortcuts([])).toEqual([]);
    expect(rankShortcuts()).toEqual([]);
  });
});

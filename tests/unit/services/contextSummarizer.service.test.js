const contextSummarizer = require('../../../services/contextSummarizer.service');

describe('contextSummarizer', () => {
  test('sanitizes indexable text without leaking PII or raw references', () => {
    const sanitized = contextSummarizer.sanitizeText(
      'Invoice INV-ABC-123 for customer@example.com, +92 300 1234567, NTN 1234567, description REF-778899.'
    );

    expect(sanitized).toContain('[reference redacted]');
    expect(sanitized).toContain('[email redacted]');
    expect(sanitized).toContain('[phone redacted]');
    expect(sanitized).toContain('[tax id redacted]');
    expect(sanitized).not.toContain('$1');
    expect(sanitized).not.toContain('customer@example.com');
    expect(sanitized).not.toContain('1234567');
    expect(sanitized).not.toContain('778899');
  });

  test('invoice summaries omit party names and exact amounts', async () => {
    const [summary] = await contextSummarizer.summarizeInvoices('64f000000000000000000001', [
      {
        _id: 'invoice-1',
        customerName: 'ABC Corp',
        totalAmount: 52140,
        issueDate: new Date('2026-06-01'),
        dueDate: new Date(Date.now() - 11 * 86400000),
        status: 'overdue',
      },
    ]);

    expect(summary.summary).toContain('~PKR 52K');
    expect(summary.summary).not.toContain('52,140');
    expect(summary.summary).not.toContain('52140');
    expect(summary.summary).not.toContain('ABC Corp');
    expect(summary.dataType).toBe('invoice_summary');
  });

  test('P&L summary communicates revenue decline without exact figures', async () => {
    const summary = await contextSummarizer.summarizePnL('64f000000000000000000001', '2026-05', {
      totalRevenue: 1000000,
      totalExpenses: 700000,
      grossProfit: 600000,
      netIncome: 300000,
      operatingExpenses: 300000,
      revenueGrowth: -8,
    });

    expect(summary.summary).toMatch(/declined approximately 8%/i);
    expect(summary.summary).toContain('~PKR 1M');
    expect(summary.summary).not.toContain('1,000,000');
    expect(summary.dataType).toBe('monthly_pnl');
  });

  test('journal summaries avoid raw descriptions while preserving accounting shape', async () => {
    const [summary] = await contextSummarizer.summarizeJournalEntries('64f000000000000000000001', [
      {
        _id: 'journal-1',
        transactionDate: new Date('2026-06-10'),
        transactionType: 'Expense',
        amount: 45200,
        description: 'Payroll run for Ahmed Khan',
        debitAccountId: { accountName: 'Salaries Expense' },
        creditAccountId: { accountName: 'Cash' },
        affectsCashFlow: true,
      },
    ]);

    expect(summary.summary).toContain('~PKR 45K');
    expect(summary.summary).toContain('salaries expense');
    expect(summary.summary).not.toContain('Ahmed Khan');
    expect(summary.summary).not.toContain('45,200');
  });
});

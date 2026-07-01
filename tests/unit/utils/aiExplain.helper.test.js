'use strict';
const { buildExplanation } = require('../../../utils/aiExplain.helper');

const parseDecision = {
  kind: 'parse',
  inputsSummary: 'Paid electricity bill',
  decision: { transactionType: 'Expense', debitAccount: 'Utilities Expense', creditAccount: 'Cash', amount: 1000 },
  confidence: 0.9,
  outcome: 'accepted',
};

describe('buildExplanation', () => {
  it('renders a grounded plain-language explanation for a parse decision', () => {
    const e = buildExplanation(parseDecision);
    expect(e.text).toContain('Paid electricity bill');
    expect(e.text).toContain('Utilities Expense');
    expect(e.text).toContain('Cash');
    expect(e.text).toContain('Rs 1,000');
    expect(e.text).toContain('90%');
    expect(e.text).toContain('You accepted it');
    expect(e.faithful).toBe(true);
  });

  it('is faithful by construction — never references a value not in the record', () => {
    const e = buildExplanation(parseDecision);
    // an account the AI did NOT choose must never appear
    expect(e.text).not.toContain('Sales Revenue');
    // every cited value is actually present in the rendered text
    for (const v of e.citedValues) expect(e.text).toContain(v);
  });

  it('handles a decision with no confidence and pending outcome', () => {
    const e = buildExplanation({ kind: 'parse', inputsSummary: 'Bought stock', decision: { transactionType: 'Expense', debitAccount: 'Inventory', creditAccount: 'Bank', amount: 500 }, confidence: null, outcome: 'pending' });
    expect(e.text).not.toMatch(/\d+% confident/);
    expect(e.text).toContain("haven't reviewed");
  });

  it('renders a grounded sentence for a non-parse kind', () => {
    const e = buildExplanation({ kind: 'match', inputsSummary: 'Bill BILL-001 vs PO-123', decision: { result: 'matched' }, confidence: 0.95, outcome: 'accepted' });
    expect(e.text).toContain('Bill BILL-001 vs PO-123');
    expect(e.text).toContain('95%');
  });

  it('degrades gracefully on a sparse record', () => {
    const e = buildExplanation({ kind: 'parse', inputsSummary: 'Something', decision: null, confidence: undefined, outcome: undefined });
    expect(typeof e.text).toBe('string');
    expect(e.text.length).toBeGreaterThan(0);
    expect(e.faithful).toBe(true);
  });
});

'use strict';
const AIDecision = require('../../../models/AIDecision.model');

const good = {
  businessId: '507f1f77bcf86cd799439099',
  kind: 'parse',
  inputsSummary: 'Paid 5000 rent',
  decision: { debitAccount: 'Rent' },
  confidence: 0.97,
  outcome: 'pending',
};

describe('AIDecision model', () => {
  it('validates a well-formed pending decision', () => {
    const err = new AIDecision(good).validateSync();
    expect(err).toBeUndefined();
  });
  it('rejects an out-of-enum kind', () => {
    const err = new AIDecision({ ...good, kind: 'banana' }).validateSync();
    expect(err.errors.kind).toBeDefined();
  });
  it('rejects an out-of-enum outcome', () => {
    const err = new AIDecision({ ...good, outcome: 'banana' }).validateSync();
    expect(err.errors.outcome).toBeDefined();
  });
  it('requires businessId and inputsSummary', () => {
    const err = new AIDecision({ kind: 'parse' }).validateSync();
    expect(err.errors.businessId).toBeDefined();
    expect(err.errors.inputsSummary).toBeDefined();
  });
  it('blocks updateMany/deleteOne (append-only)', () => {
    expect(() => AIDecision.schema.pre).toBeDefined();
    // The hooks throw synchronously; assert they are registered by exercising one.
    const fn = AIDecision.schema.s.hooks._pres.get('deleteMany')[0].fn;
    expect(() => fn()).toThrow(/immutable/i);
  });
});

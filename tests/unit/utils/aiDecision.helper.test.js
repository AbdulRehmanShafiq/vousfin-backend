'use strict';
const { buildDecisionRecord, applyOutcome } = require('../../../utils/aiDecision.helper');
const { AI_DECISION_KINDS, AI_DECISION_OUTCOMES } = require('../../../config/constants');

const BIZ = '507f1f77bcf86cd799439099';
const base = { inputsSummary: 'Paid 5000 rent from bank', decision: { debitAccount: 'Rent' }, confidence: 0.97, model: 'gemini-flash' };

describe('buildDecisionRecord', () => {
  it('builds a pending record with defaults', () => {
    const r = buildDecisionRecord(BIZ, AI_DECISION_KINDS.PARSE, base);
    expect(r.businessId).toBe(BIZ);
    expect(r.kind).toBe('parse');
    expect(r.outcome).toBe('pending');
    expect(r.candidates).toEqual([]);
    expect(r.confidence).toBe(0.97);
  });
  it('rejects an unknown kind', () => {
    expect(() => buildDecisionRecord(BIZ, 'nonsense', base)).toThrow(/kind/i);
  });
  it('rejects a missing businessId or inputsSummary', () => {
    expect(() => buildDecisionRecord(null, AI_DECISION_KINDS.PARSE, base)).toThrow();
    expect(() => buildDecisionRecord(BIZ, AI_DECISION_KINDS.PARSE, { ...base, inputsSummary: '' })).toThrow();
  });
  it('clamps confidence to [0,1] and coerces candidates to an array', () => {
    const r = buildDecisionRecord(BIZ, AI_DECISION_KINDS.PARSE, { ...base, confidence: 1.5, candidates: null });
    expect(r.confidence).toBe(1);
    expect(r.candidates).toEqual([]);
  });
});

describe('applyOutcome', () => {
  it('allows pending → accepted/corrected/reversed', () => {
    expect(applyOutcome('pending', AI_DECISION_OUTCOMES.ACCEPTED)).toBe('accepted');
    expect(applyOutcome('pending', AI_DECISION_OUTCOMES.CORRECTED)).toBe('corrected');
    expect(applyOutcome('pending', AI_DECISION_OUTCOMES.REVERSED)).toBe('reversed');
  });
  it('refuses to change an already-set outcome', () => {
    expect(() => applyOutcome('accepted', AI_DECISION_OUTCOMES.CORRECTED)).toThrow(/already set/i);
  });
  it('rejects an invalid new outcome', () => {
    expect(() => applyOutcome('pending', 'banana')).toThrow(/invalid/i);
  });
});

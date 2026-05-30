/**
 * tests/unit/services/approvalEngine.service.test.js
 *
 * AR/AP Domain Refactor — Milestone M6 (multi-level approval).
 * Validates the approval chain, role validation, segregation of duties,
 * rejection, reassignment and escalation.
 */
'use strict';

const engine = require('../../../services/approvalEngine.service');

const CREATOR = 'creator-1';
const doc = (chain) => ({ createdBy: CREATOR, approvalChain: chain });
const userL1 = { _id: 'u-l1', fullName: 'Ann', role: 'accountant', approvalLevels: ['level_1'] };
const userL2 = { _id: 'u-l2', fullName: 'Ben', role: 'manager', approvalLevels: ['level_2'] };
const owner  = { _id: 'u-own', fullName: 'Owner', role: 'owner' };

// ── Chain construction by amount tier ────────────────────────────────────────
describe('buildChain — amount tiers', () => {
  it('≤50k → [Level 1]', () => expect(engine.buildChain(10000).map((s) => s.level)).toEqual(['level_1']));
  it('≤250k → [Level 1, Level 2]', () => expect(engine.buildChain(100000).map((s) => s.level)).toEqual(['level_1', 'level_2']));
  it('≤1M → [Level 1, Finance, Controller]', () => expect(engine.buildChain(500000).map((s) => s.level)).toEqual(['level_1', 'finance', 'controller']));
  it('>1M → adds CFO', () => expect(engine.buildChain(5000000).map((s) => s.level)).toEqual(['level_1', 'finance', 'controller', 'cfo']));
});

// ── Approval chain progression ───────────────────────────────────────────────
describe('approveStep — sequential chain', () => {
  it('advances level by level and only completes on the last step', () => {
    const d = doc(engine.buildChain(100000)); // [level_1, level_2]

    const r1 = engine.approveStep(d, userL1, 'ok');
    expect(r1.fullyApproved).toBe(false);
    expect(d.approvalChain[0].status).toBe('approved');
    expect(r1.nextStep.level).toBe('level_2');

    const r2 = engine.approveStep(d, userL2, 'ok');
    expect(r2.fullyApproved).toBe(true);
    expect(engine.isComplete(d.approvalChain)).toBe(true);
  });

  it('owner can approve any level (override)', () => {
    const d = doc(engine.buildChain(10000));
    expect(engine.approveStep(d, owner).fullyApproved).toBe(true);
  });
});

// ── Role validation ──────────────────────────────────────────────────────────
describe('role validation', () => {
  it('rejects an approver who does not hold the current step level', () => {
    const d = doc(engine.buildChain(100000)); // current = level_1
    expect(() => engine.approveStep(d, userL2)).toThrow(expect.objectContaining({ statusCode: 403 }));
  });
});

// ── Segregation of duties ────────────────────────────────────────────────────
describe('segregation of duties', () => {
  it('forbids the creator from approving, even with the right role', () => {
    const creatorWithRole = { _id: CREATOR, role: 'owner' };
    const d = doc(engine.buildChain(10000));
    expect(() => engine.approveStep(d, creatorWithRole)).toThrow(expect.objectContaining({ statusCode: 403 }));
  });
});

// ── Rejection ────────────────────────────────────────────────────────────────
describe('rejectStep', () => {
  it('marks the current step rejected and flags the chain rejected', () => {
    const d = doc(engine.buildChain(100000));
    engine.rejectStep(d, userL1, 'wrong totals');
    expect(d.approvalChain[0].status).toBe('rejected');
    expect(engine.isRejected(d.approvalChain)).toBe(true);
    expect(engine.isComplete(d.approvalChain)).toBe(false);
  });
});

// ── Reassignment ─────────────────────────────────────────────────────────────
describe('reassignStep', () => {
  it('reassigns the current pending step to a different level and keeps it pending', () => {
    const d = doc(engine.buildChain(10000)); // [level_1]
    engine.reassignStep(d, 'finance', owner, 'send to finance');
    const step = engine.currentStep(d.approvalChain);
    expect(step.level).toBe('finance');
    expect(step.requiredRole).toBe('finance');
    expect(step.status).toBe('pending');
    expect(step.history.some((h) => h.action === 'reassigned')).toBe(true);
  });
  it('rejects reassigning to an unknown level', () => {
    const d = doc(engine.buildChain(10000));
    expect(() => engine.reassignStep(d, 'nonsense', owner)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});

// ── Escalation ───────────────────────────────────────────────────────────────
describe('escalateStep', () => {
  it('bumps the current step to the next-higher authority', () => {
    const d = doc(engine.buildChain(10000)); // current = level_1
    engine.escalateStep(d, owner, 'needs higher sign-off');
    expect(engine.currentStep(d.approvalChain).level).toBe('level_2');
  });
  it('cannot escalate beyond CFO', () => {
    const d = doc([{ sequence: 1, level: 'cfo', name: 'CFO', requiredRole: 'cfo', status: 'pending', history: [] }]);
    expect(() => engine.escalateStep(d, owner)).toThrow(expect.objectContaining({ statusCode: 409 }));
  });
});

// ── Summary ──────────────────────────────────────────────────────────────────
describe('summarize', () => {
  it('reports progress + current step', () => {
    const d = doc(engine.buildChain(100000));
    engine.approveStep(d, userL1);
    const s = engine.summarize(d.approvalChain);
    expect(s).toMatchObject({ total: 2, approved: 1, complete: false, rejected: false });
    expect(s.current.level).toBe('level_2');
  });
});

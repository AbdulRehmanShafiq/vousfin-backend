/**
 * tests/unit/services/internalAudit.service.test.js — Phase 6C
 *
 * TDD tests written BEFORE the service implementation.
 * Mocks: auditPlan.repository, auditFinding.repository, JournalEntry model.
 */
'use strict';

// ── mocks ────────────────────────────────────────────────────────────────────
jest.mock('../../../repositories/auditPlan.repository', () => ({
  findByBusiness: jest.fn(),
  findOwned:      jest.fn(),
  create:         jest.fn(),
  update:         jest.fn(),
}));
jest.mock('../../../repositories/auditFinding.repository', () => ({
  findByBusiness:    jest.fn(),
  findOwned:         jest.fn(),
  findOpenByBusiness:jest.fn(),
  create:            jest.fn(),
  update:            jest.fn(),
}));

// JournalEntry model — mock the whole module so require() in service gets our version.
const mockJEFindChain = { sort: jest.fn(), limit: jest.fn(), lean: jest.fn() };
const mockJEAggregate = jest.fn();
jest.mock('../../../models/JournalEntry.model', () => ({
  find:      jest.fn(() => mockJEFindChain),
  aggregate: mockJEAggregate,
}));

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

// ── subject & deps ───────────────────────────────────────────────────────────
const internalAuditService = require('../../../services/internalAudit.service');
const auditPlanRepo        = require('../../../repositories/auditPlan.repository');
const auditFindingRepo     = require('../../../repositories/auditFinding.repository');
const JournalEntry         = require('../../../models/JournalEntry.model');

const BIZ    = '507f1f77bcf86cd799439011';
const PLAN_ID = '507f1f77bcf86cd799439022';
const FINDING_ID = '507f1f77bcf86cd799439033';
const ACTOR  = { _id: '507f1f77bcf86cd799439044', id: '507f1f77bcf86cd799439044' };

beforeEach(() => {
  jest.clearAllMocks();
  // Reset the find chain stubs
  mockJEFindChain.sort.mockReturnValue(mockJEFindChain);
  mockJEFindChain.limit.mockReturnValue(mockJEFindChain);
  mockJEFindChain.lean.mockResolvedValue([]);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('internalAuditService.createPlan()', () => {
  it('creates a plan with createdBy from actor._id', async () => {
    const planData = {
      name: 'Q1 Audit', periodStart: new Date('2026-01-01'),
      periodEnd: new Date('2026-03-31'), sampleStrategy: 'risk_based', sampleSize: 20,
    };
    const saved = { _id: PLAN_ID, ...planData, businessId: BIZ, status: 'draft' };
    auditPlanRepo.create.mockResolvedValue(saved);

    const result = await internalAuditService.createPlan(BIZ, planData, ACTOR);

    expect(auditPlanRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BIZ, name: 'Q1 Audit', createdBy: ACTOR._id }),
    );
    expect(result._id).toBe(PLAN_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('internalAuditService.getPlan()', () => {
  it('throws 404 when plan not owned by business', async () => {
    auditPlanRepo.findOwned.mockResolvedValue(null);
    await expect(internalAuditService.getPlan(PLAN_ID, BIZ)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns the plan when owned', async () => {
    const plan = { _id: PLAN_ID, businessId: BIZ, name: 'Test' };
    auditPlanRepo.findOwned.mockResolvedValue(plan);
    const result = await internalAuditService.getPlan(PLAN_ID, BIZ);
    expect(result._id).toBe(PLAN_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('internalAuditService.updatePlanStatus()', () => {
  it('throws 400 for an invalid status', async () => {
    await expect(internalAuditService.updatePlanStatus(PLAN_ID, BIZ, 'bad_status'))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws 404 when plan not owned', async () => {
    auditPlanRepo.findOwned.mockResolvedValue(null);
    await expect(internalAuditService.updatePlanStatus(PLAN_ID, BIZ, 'completed'))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('updates to a valid status', async () => {
    const plan = { _id: PLAN_ID, businessId: BIZ, status: 'draft' };
    auditPlanRepo.findOwned.mockResolvedValue(plan);
    const updated = { ...plan, status: 'in_progress' };
    auditPlanRepo.update.mockResolvedValue(updated);

    const result = await internalAuditService.updatePlanStatus(PLAN_ID, BIZ, 'in_progress');
    expect(result.status).toBe('in_progress');
    expect(auditPlanRepo.update).toHaveBeenCalledWith(PLAN_ID, { status: 'in_progress' }, expect.anything());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('internalAuditService.drawSample()', () => {
  const basePlan = {
    _id: PLAN_ID, businessId: BIZ, status: 'draft',
    periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-03-31'),
    sampleStrategy: 'risk_based', sampleSize: 5,
    save: jest.fn().mockResolvedValue(true),
  };

  beforeEach(() => {
    // findOwned returns a lean plan; for save() we need a non-lean doc
    // The service will call model.findOne for the save path — mock findOwned as returning a plan object.
    // For simplicity we mock findOwned to return an object with save() attached.
    auditPlanRepo.findOwned.mockResolvedValue(null); // overridden per test
  });

  it('throws 404 when plan not found', async () => {
    auditPlanRepo.findOwned.mockResolvedValue(null);
    await expect(internalAuditService.drawSample(PLAN_ID, BIZ)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('risk_based: sorts by amount desc and limits to sampleSize', async () => {
    const entries = [
      { _id: 'e1', transactionDate: new Date(), amount: 5000, description: 'Big', transactionType: 'revenue' },
      { _id: 'e2', transactionDate: new Date(), amount: 100,  description: 'Small', transactionType: 'expense' },
    ];
    mockJEFindChain.lean.mockResolvedValue(entries);

    auditPlanRepo.findOwned.mockResolvedValue({ ...basePlan, save: jest.fn().mockResolvedValue(true) });
    auditPlanRepo.update.mockResolvedValue({ ...basePlan, status: 'in_progress' });

    const result = await internalAuditService.drawSample(PLAN_ID, BIZ);

    expect(JournalEntry.find).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BIZ }),
    );
    expect(mockJEFindChain.sort).toHaveBeenCalledWith({ amount: -1 });
    expect(mockJEFindChain.limit).toHaveBeenCalledWith(5);
    expect(result).toHaveLength(2);
    expect(result[0]._id).toBe('e1');
  });

  it('random: uses aggregation $sample', async () => {
    const entries = [{ _id: 'e3', transactionDate: new Date(), amount: 200, description: 'R', transactionType: 'expense' }];
    mockJEAggregate.mockResolvedValue(entries);

    auditPlanRepo.findOwned.mockResolvedValue({
      ...basePlan, sampleStrategy: 'random', save: jest.fn().mockResolvedValue(true),
    });
    auditPlanRepo.update.mockResolvedValue({ ...basePlan, status: 'in_progress' });

    const result = await internalAuditService.drawSample(PLAN_ID, BIZ);

    expect(JournalEntry.aggregate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ $match: expect.any(Object) }),
        expect.objectContaining({ $sample: { size: 5 } }),
      ]),
    );
    expect(result).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('internalAuditService.raiseFinding()', () => {
  it('throws 404 when plan not owned', async () => {
    auditPlanRepo.findOwned.mockResolvedValue(null);
    await expect(
      internalAuditService.raiseFinding(BIZ, { planId: PLAN_ID, observation: 'X', riskRating: 'high' }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('creates a finding with createdBy from actor', async () => {
    auditPlanRepo.findOwned.mockResolvedValue({ _id: PLAN_ID, businessId: BIZ });
    const saved = { _id: FINDING_ID, planId: PLAN_ID, observation: 'X', riskRating: 'high' };
    auditFindingRepo.create.mockResolvedValue(saved);

    const result = await internalAuditService.raiseFinding(
      BIZ, { planId: PLAN_ID, observation: 'X', riskRating: 'high' }, ACTOR,
    );

    expect(auditFindingRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BIZ, planId: PLAN_ID, createdBy: ACTOR._id }),
    );
    expect(result._id).toBe(FINDING_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('internalAuditService.recordResponse()', () => {
  it('throws 404 when finding not owned', async () => {
    auditFindingRepo.findOwned.mockResolvedValue(null);
    await expect(
      internalAuditService.recordResponse(FINDING_ID, BIZ, { managementResponse: 'OK' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('updates only provided fields', async () => {
    auditFindingRepo.findOwned.mockResolvedValue({ _id: FINDING_ID, businessId: BIZ, status: 'open' });
    const updated = { _id: FINDING_ID, managementResponse: 'Noted', status: 'in_progress' };
    auditFindingRepo.update.mockResolvedValue(updated);

    const result = await internalAuditService.recordResponse(
      FINDING_ID, BIZ, { managementResponse: 'Noted', status: 'in_progress' },
    );

    expect(auditFindingRepo.update).toHaveBeenCalledWith(
      FINDING_ID,
      expect.objectContaining({ managementResponse: 'Noted', status: 'in_progress' }),
      expect.anything(),
    );
    expect(result.status).toBe('in_progress');
  });

  it('throws 400 for invalid status', async () => {
    auditFindingRepo.findOwned.mockResolvedValue({ _id: FINDING_ID, businessId: BIZ });
    await expect(
      internalAuditService.recordResponse(FINDING_ID, BIZ, { status: 'bad' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('internalAuditService.agingReport()', () => {
  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d;
  };

  it('buckets findings by age since createdAt', async () => {
    const findings = [
      { _id: 'f1', riskRating: 'critical', createdAt: daysAgo(10),  status: 'open' },        // 0-30
      { _id: 'f2', riskRating: 'high',     createdAt: daysAgo(45),  status: 'in_progress' }, // 31-60
      { _id: 'f3', riskRating: 'medium',   createdAt: daysAgo(75),  status: 'open' },        // 61-90
      { _id: 'f4', riskRating: 'low',      createdAt: daysAgo(100), status: 'open' },        // 90+
      { _id: 'f5', riskRating: 'high',     createdAt: daysAgo(5),   status: 'open' },        // 0-30
    ];
    auditFindingRepo.findOpenByBusiness.mockResolvedValue(findings);

    const report = await internalAuditService.agingReport(BIZ);

    // bucket counts
    expect(report.buckets['0-30']).toHaveLength(2);
    expect(report.buckets['31-60']).toHaveLength(1);
    expect(report.buckets['61-90']).toHaveLength(1);
    expect(report.buckets['90+']).toHaveLength(1);
    expect(report.total).toBe(5);

    // byRisk counts
    expect(report.byRisk.critical).toBe(1);
    expect(report.byRisk.high).toBe(2);
    expect(report.byRisk.medium).toBe(1);
    expect(report.byRisk.low).toBe(1);
  });

  it('returns empty report when no open findings', async () => {
    auditFindingRepo.findOpenByBusiness.mockResolvedValue([]);
    const report = await internalAuditService.agingReport(BIZ);
    expect(report.total).toBe(0);
    expect(report.buckets['0-30']).toHaveLength(0);
  });
});

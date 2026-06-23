// tests/integration/rbac.enforcement.test.js — Phase 6A
// Verifies requirePermission actually blocks an under-privileged member at the
// route layer (and lets an owner through), using a minimal app that simulates
// attachMembership having already run.
'use strict';
const express = require('express');
const request = require('supertest');
const { requirePermission } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');

function buildApp(membership) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.membership = membership; next(); }); // stand-in for attachMembership
  app.post('/approve', requirePermission(PERMISSIONS.TRANSACTION_APPROVE), (_req, res) => res.json({ ok: true }));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ message: err.message }));
  return app;
}

describe('RBAC route enforcement', () => {
  test('viewer (report:view only) is blocked from an approve route → 403', async () => {
    const res = await request(buildApp({ roles: ['viewer'], permissions: ['report:view'] })).post('/approve').send({});
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/permission/i);
  });

  test('approver is allowed through the approve route → 200', async () => {
    const res = await request(buildApp({ roles: ['approver'], permissions: ['transaction:approve', 'report:view'] })).post('/approve').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('owner wildcard is allowed through any guarded route → 200', async () => {
    const res = await request(buildApp({ roles: ['owner'], permissions: ['*'] })).post('/approve').send({});
    expect(res.status).toBe(200);
  });
});

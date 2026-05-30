// services/forecasting/platform/tenantScope.js
//
// Forecast Platform — Foundation (F1). TENANT ISOLATION LAYER.
//
// Single, mandatory choke-point through which every dataset/feature read passes.
// Enforces the platform's #1 invariant: "never mix tenant data". Every Mongo
// filter built for the forecasting platform MUST originate here so a missing or
// wrong businessId fails fast instead of silently scanning another tenant.
//
'use strict';
const mongoose = require('mongoose');
const { ApiError } = require('../../../utils/ApiError');

/** Throw unless `businessId` is a valid ObjectId. Returns the ObjectId. */
function assertTenant(businessId) {
  if (!businessId || !mongoose.Types.ObjectId.isValid(businessId)) {
    throw new ApiError(400, 'Forecast platform: a valid businessId is required (tenant isolation)');
  }
  return new mongoose.Types.ObjectId(businessId);
}

/** Build a tenant-scoped Mongo filter; `businessId` is always forced last so it
 *  can never be overridden by caller-supplied `extra`. */
function scopeFilter(businessId, extra = {}) {
  const id = assertTenant(businessId);
  return { ...extra, businessId: id };
}

/** Guard that two ids belong to the same tenant (serving-boundary check). */
function assertSameTenant(expected, actual) {
  if (String(expected) !== String(actual)) {
    throw new ApiError(403, 'Forecast platform: cross-tenant access denied');
  }
}

/** Stamp a tenant id onto an out-bound record (defensive, for writes). */
function tag(businessId, doc = {}) {
  return { ...doc, businessId: assertTenant(businessId) };
}

module.exports = { assertTenant, scopeFilter, assertSameTenant, tag };

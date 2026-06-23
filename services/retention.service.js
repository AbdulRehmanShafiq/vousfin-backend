// services/retention.service.js — FR-10.4 Document Retention
'use strict';
const { ApiError } = require('../utils/ApiError');
const RetentionPolicy = require('../models/RetentionPolicy.model');

class RetentionService {
  static DEFAULT_POLICIES = [
    { docType: 'financial_record',    retentionYears: 7,  archiveAfterYears: 2 },
    { docType: 'corporate_document',  retentionYears: 10, archiveAfterYears: 3 },
    { docType: 'contract',            retentionYears: 7,  archiveAfterYears: 2 },
    { docType: 'payroll_record',      retentionYears: 7,  archiveAfterYears: 2 },
    { docType: 'tax_document',        retentionYears: 10, archiveAfterYears: 2 },
  ];

  async getEffectivePolicy(businessId, docType) {
    const custom = await RetentionPolicy.findOne({ businessId, docType });
    if (custom) return custom;
    const def = RetentionService.DEFAULT_POLICIES.find((p) => p.docType === docType);
    return def || RetentionService.DEFAULT_POLICIES[0]; // fallback to financial_record
  }

  /**
   * Throws ApiError(403) if the document is too young to delete.
   */
  async checkDeletion(businessId, docType, createdAt) {
    const policy = await this.getEffectivePolicy(businessId, docType);
    const ageMs = Date.now() - new Date(createdAt).getTime();
    const retentionMs = policy.retentionYears * 365 * 24 * 60 * 60 * 1000;
    if (ageMs < retentionMs) {
      throw new ApiError(
        403,
        `This document cannot be deleted — it must be kept for ${policy.retentionYears} years.`,
      );
    }
    return true;
  }

  /**
   * Returns true if the document is old enough to be archived.
   */
  async checkArchival(businessId, docType, createdAt) {
    const policy = await this.getEffectivePolicy(businessId, docType);
    const ageMs = Date.now() - new Date(createdAt).getTime();
    const archiveMs = policy.archiveAfterYears * 365 * 24 * 60 * 60 * 1000;
    return ageMs >= archiveMs;
  }

  /**
   * Return merged list: custom policies override defaults by docType.
   */
  async listPolicies(businessId) {
    const customs = await RetentionPolicy.find({ businessId }).lean();
    const customMap = Object.fromEntries(customs.map((c) => [c.docType, c]));

    return RetentionService.DEFAULT_POLICIES.map((def) => customMap[def.docType] || { ...def, businessId, isDefault: true }).concat(
      customs.filter((c) => !RetentionService.DEFAULT_POLICIES.find((d) => d.docType === c.docType)),
    );
  }

  /**
   * Upsert an array of policies for the business.
   */
  async setPolicies(businessId, policies) {
    const results = [];
    for (const p of policies) {
      const doc = await RetentionPolicy.findOneAndUpdate(
        { businessId, docType: p.docType },
        { $set: { businessId, docType: p.docType, retentionYears: p.retentionYears, archiveAfterYears: p.archiveAfterYears } },
        { upsert: true, new: true },
      );
      results.push(doc);
    }
    return results;
  }
}

module.exports = new RetentionService();

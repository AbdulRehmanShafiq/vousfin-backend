// services/billDocument.service.js
//
// Phase 3.3 — Document Management Service
//
// Handles secure file metadata persistence, document linking to bills/POs,
// and audit trail.  Actual binary storage lives outside (multer → disk/cloud);
// this service manages the BillDocument metadata records.
//
'use strict';
const mongoose = require('mongoose');
const BillDocument = require('../models/BillDocument.model');
const Bill         = require('../models/Bill.model');
const { ApiError } = require('../utils/ApiError');
const { DOCUMENT_TYPES, DOCUMENT_STATES } = require('../config/constants');
const logger = require('../config/logger');
const retentionService = require('./retention.service');

class BillDocumentService {

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _validateId(id, label = 'id') {
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, `Invalid ${label}`);
    }
  }

  // ── Create / Upload ─────────────────────────────────────────────────────────

  /**
   * Record a newly-uploaded file and optionally link it to a bill.
   *
   * @param {object} params
   * @param {string} params.businessId
   * @param {string} [params.billId]
   * @param {string} [params.vendorId]
   * @param {string} [params.purchaseOrderId]
   * @param {string} params.documentType   — one of DOCUMENT_TYPES values
   * @param {string} params.fileName
   * @param {string} params.originalName
   * @param {string} params.mimeType
   * @param {number} params.fileSize
   * @param {string} params.fileUrl
   * @param {string} [params.storageKey]
   * @param {string} [params.description]
   * @param {object} actor  — { _id, fullName }
   */
  async upload(params, actor) {
    const {
      businessId, billId, vendorId, purchaseOrderId,
      documentType = DOCUMENT_TYPES.ATTACHMENT,
      fileName, originalName, mimeType, fileSize,
      fileUrl, storageKey, description,
    } = params;

    this._validateId(businessId, 'businessId');
    if (!fileName || !fileUrl) throw new ApiError(400, 'fileName and fileUrl are required');
    if (!Object.values(DOCUMENT_TYPES).includes(documentType)) {
      throw new ApiError(400, `Invalid documentType: ${documentType}`);
    }

    const doc = await BillDocument.create({
      businessId,
      billId:          billId || null,
      vendorId:        vendorId || null,
      purchaseOrderId: purchaseOrderId || null,
      documentType,
      fileName,
      originalName:    originalName || fileName,
      mimeType:        mimeType || null,
      fileSize:        fileSize || null,
      fileUrl,
      storageKey:      storageKey || null,
      state:           DOCUMENT_STATES.AVAILABLE,
      description:     description || null,
      uploadedBy:      actor?._id || null,
      uploadedAt:      new Date(),
      auditLog: [{
        action:    'uploaded',
        actorId:   actor?._id || null,
        actorName: actor?.fullName || actor?.email || 'system',
        timestamp: new Date(),
      }],
    });

    // Link document to bill if billId given
    if (billId && mongoose.Types.ObjectId.isValid(billId)) {
      await Bill.findOneAndUpdate(
        { _id: billId, businessId },
        { $addToSet: { documentIds: doc._id } }
      );
    }

    logger.info(`[billDoc] uploaded ${doc._id} type=${documentType} bill=${billId || 'none'}`);
    return doc;
  }

  // ── Fetch ────────────────────────────────────────────────────────────────────

  /**
   * List all documents for a given bill.
   */
  async listByBill(billId, businessId) {
    this._validateId(billId, 'billId');
    return BillDocument.find({ billId, businessId, isArchived: false })
      .sort({ uploadedAt: -1 })
      .lean();
  }

  /**
   * List all documents for a given vendor.
   */
  async listByVendor(vendorId, businessId) {
    this._validateId(vendorId, 'vendorId');
    return BillDocument.find({ vendorId, businessId, isArchived: false })
      .sort({ uploadedAt: -1 })
      .lean();
  }

  /**
   * Get a single document by ID (with businessId guard).
   */
  async getById(id, businessId) {
    this._validateId(id, 'documentId');
    const doc = await BillDocument.findOne({ _id: id, businessId, isArchived: false }).lean();
    if (!doc) throw new ApiError(404, 'Document not found');
    return doc;
  }

  // ── Link / Unlink ────────────────────────────────────────────────────────────

  /**
   * Attach an existing document to a different (or additional) bill.
   */
  async linkToBill(docId, billId, businessId, actor) {
    this._validateId(docId, 'documentId');
    this._validateId(billId, 'billId');

    const doc = await BillDocument.findOne({ _id: docId, businessId });
    if (!doc) throw new ApiError(404, 'Document not found');

    doc.billId = billId;
    doc.auditLog.push({
      action:    'linked',
      actorId:   actor?._id || null,
      actorName: actor?.fullName || 'system',
      note:      `Linked to bill ${billId}`,
      timestamp: new Date(),
    });
    await doc.save();

    await Bill.findOneAndUpdate(
      { _id: billId, businessId },
      { $addToSet: { documentIds: docId } }
    );

    return doc;
  }

  // ── Archive / Delete ─────────────────────────────────────────────────────────

  /**
   * Soft-archive a document (keeps the DB record, marks isArchived).
   */
  async archive(id, businessId, actor) {
    this._validateId(id, 'documentId');

    const doc = await BillDocument.findOne({ _id: id, businessId });
    if (!doc) throw new ApiError(404, 'Document not found');

    // Retention enforcement — throws 403 if too young to delete
    await retentionService.checkDeletion(businessId, 'financial_record', doc.createdAt);

    doc.isArchived = true;
    doc.auditLog.push({
      action:    'archived',
      actorId:   actor?._id || null,
      actorName: actor?.fullName || 'system',
      timestamp: new Date(),
    });
    await doc.save();
    return doc;
  }

  // ── Update OCR result ────────────────────────────────────────────────────────

  /**
   * Store OCR-extracted text and metadata (called by an async OCR pipeline).
   */
  async updateOcr(id, businessId, { ocrText, ocrMeta }) {
    this._validateId(id, 'documentId');

    const doc = await BillDocument.findOneAndUpdate(
      { _id: id, businessId },
      {
        $set: {
          ocrText,
          ocrMeta: ocrMeta || null,
          state:   DOCUMENT_STATES.AVAILABLE,
        },
      },
      { new: true }
    );
    if (!doc) throw new ApiError(404, 'Document not found');
    return doc;
  }

  // ── Document count summary ───────────────────────────────────────────────────

  /**
   * Returns a count summary grouped by documentType for a bill.
   */
  async summaryByBill(billId, businessId) {
    this._validateId(billId, 'billId');
    const rows = await BillDocument.aggregate([
      { $match: { billId: new mongoose.Types.ObjectId(billId), businessId: new mongoose.Types.ObjectId(businessId), isArchived: false } },
      { $group: { _id: '$documentType', count: { $sum: 1 } } },
    ]);
    const out = {};
    for (const r of rows) out[r._id] = r.count;
    return out;
  }
}

module.exports = new BillDocumentService();

const mongoose = require('mongoose');

const vectorDocumentSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    dataType: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    // 'tenant' = per-business financial vectors (default — existing behavior).
    // 'global' = app-catalog/help vectors shared by every business (stored under
    // the reserved GLOBAL_CATALOG_BUSINESS_ID sentinel so the businessId filter
    // keeps them strictly isolated from tenant search and vice-versa).
    scope: {
      type: String,
      enum: ['tenant', 'global'],
      default: 'tenant',
      index: true,
    },
    recordId: {
      type: String,
      required: true,
      trim: true,
    },
    period: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    summary: {
      type: String,
      required: true,
      maxlength: 6000,
    },
    embedding: {
      type: [Number],
      required: true,
      validate: {
        validator(value) {
          return Array.isArray(value) && value.length > 0;
        },
        message: 'Embedding must be a non-empty number array',
      },
    },
    summaryHash: {
      type: String,
      required: true,
      index: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    collection: 'vectorDocuments',
    toJSON: {
      transform: (doc, ret) => {
        delete ret.__v;
        delete ret.embedding;
        return ret;
      },
    },
  }
);

vectorDocumentSchema.index(
  { businessId: 1, recordId: 1, dataType: 1 },
  { unique: true }
);
vectorDocumentSchema.index({ businessId: 1, dataType: 1, period: 1 });
vectorDocumentSchema.index({ businessId: 1, updatedAt: -1 });

const VectorDocument = mongoose.model('VectorDocument', vectorDocumentSchema);

module.exports = VectorDocument;

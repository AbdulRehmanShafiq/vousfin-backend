// models/RetentionPolicy.model.js — FR-10.4 Document Retention
'use strict';
const mongoose = require('mongoose');

const retentionPolicySchema = new mongoose.Schema(
  {
    businessId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    docType:           { type: String, required: true, trim: true },
    retentionYears:    { type: Number, required: true, min: 1 },
    archiveAfterYears: { type: Number, required: true, min: 1 },
    isDefault:         { type: Boolean, default: false },
  },
  {
    timestamps: true,
    toJSON: { transform: (doc, ret) => { delete ret.__v; return ret; } },
  },
);

retentionPolicySchema.index({ businessId: 1, docType: 1 }, { unique: true });

module.exports = mongoose.model('RetentionPolicy', retentionPolicySchema);

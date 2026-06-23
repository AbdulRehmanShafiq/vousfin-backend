// models/CounterpartyScreening.model.js — FR-10.3 AML/KYC Screening
'use strict';
const mongoose = require('mongoose');

const counterpartyScreeningSchema = new mongoose.Schema(
  {
    businessId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    counterpartyType: { type: String, enum: ['customer', 'vendor'], required: true },
    counterpartyId:   { type: mongoose.Schema.Types.ObjectId, required: true },
    counterpartyName: { type: String, required: true },
    screeningDate:    { type: Date, default: Date.now },
    result:           { type: String, enum: ['clear', 'flagged', 'pending_review'], default: 'pending_review' },
    riskScore:        { type: Number, default: 0, min: 0, max: 100 },
    flags:            { type: [String], default: [] },
    threshold:        { type: Number, default: 500000 }, // PKR
    justification:    { type: String, default: '' },
    strDrafted:       { type: Boolean, default: false },
    reviewedBy:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt:       { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { transform: (doc, ret) => { delete ret.__v; return ret; } },
  },
);

counterpartyScreeningSchema.index({ businessId: 1, counterpartyId: 1 }, { unique: true });

module.exports = mongoose.model('CounterpartyScreening', counterpartyScreeningSchema);

// models/ImpairmentCheck.model.js — FR-10.2 IAS-36 Impairment
'use strict';
const mongoose = require('mongoose');

const impairmentCheckSchema = new mongoose.Schema(
  {
    businessId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    assetName:        { type: String, required: true, trim: true, maxlength: 200 },
    assetAccountId:   { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    carryingAmount:   { type: Number, required: true, min: 0 },
    recoverableAmount:{ type: Number, required: true, min: 0 },
    impairmentLoss:   { type: Number }, // computed: max(0, carryingAmount - recoverableAmount)
    indicators:       { type: [String], default: [] },
    assessmentDate:   { type: Date, required: true, default: Date.now },
    status:           { type: String, enum: ['assessed', 'loss_posted', 'no_impairment'], default: 'assessed' },
    createdBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    toJSON: { transform: (doc, ret) => { delete ret.__v; return ret; } },
  },
);

module.exports = mongoose.model('ImpairmentCheck', impairmentCheckSchema);

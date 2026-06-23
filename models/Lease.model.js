// models/Lease.model.js — FR-10.2 IFRS-16 Leases
'use strict';
const mongoose = require('mongoose');

const leaseSchema = new mongoose.Schema(
  {
    businessId:              { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    assetName:               { type: String, required: true, trim: true, maxlength: 200 },
    commencementDate:        { type: Date, required: true },
    leaseTerm:               { type: Number, required: true }, // months
    monthlyPayment:          { type: Number, required: true, min: 0 },
    discountRate:            { type: Number, required: true, min: 0, max: 1 }, // annual rate e.g. 0.12
    currency:                { type: String, default: 'PKR' },
    status:                  { type: String, enum: ['active', 'terminated', 'expired'], default: 'active' },
    rouAssetAccountId:       { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    leaseLiabilityAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    lastAmortizationDate:    { type: Date, default: null },
    createdBy:               { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    toJSON: { transform: (doc, ret) => { delete ret.__v; return ret; } },
  },
);

module.exports = mongoose.model('Lease', leaseSchema);

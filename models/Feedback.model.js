'use strict';
const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema(
  {
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', default: null },
    name:       { type: String, default: '' },
    email:      { type: String, default: '' },
    type:       { type: String, enum: ['bug', 'feature', 'general', 'praise', 'other'], default: 'general' },
    subject:    { type: String, trim: true, maxlength: 200, default: '' },
    message:    { type: String, required: true, trim: true, maxlength: 4000 },
    rating:     { type: Number, min: 1, max: 5, default: null },
    status:     { type: String, enum: ['new', 'reviewed', 'resolved'], default: 'new' },
    adminNote:  { type: String, default: '' },
  },
  {
    timestamps: true,
    toJSON: { transform: (doc, ret) => { delete ret.__v; return ret; } },
  },
);

module.exports = mongoose.model('Feedback', feedbackSchema);

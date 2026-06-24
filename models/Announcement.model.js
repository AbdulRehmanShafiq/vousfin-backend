'use strict';
const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema(
  {
    title:     { type: String, required: true, trim: true, maxlength: 160 },
    body:      { type: String, required: true, trim: true, maxlength: 1000 },
    type:      { type: String, enum: ['info', 'warning', 'success'], default: 'info' },
    active:    { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    expiresAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { transform: (doc, ret) => { delete ret.__v; return ret; } },
  },
);

module.exports = mongoose.model('Announcement', announcementSchema);

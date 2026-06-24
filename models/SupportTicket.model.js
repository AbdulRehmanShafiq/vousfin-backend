'use strict';
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    from:     { type: String, enum: ['user', 'admin'], required: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, required: true },
    body:     { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const supportTicketSchema = new mongoose.Schema(
  {
    userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    businessId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Business', default: null },
    requesterName:  { type: String, default: '' },
    requesterEmail: { type: String, default: '' },
    subject:        { type: String, required: true, trim: true, maxlength: 200 },
    category:       { type: String, enum: ['question', 'problem', 'billing', 'other'], default: 'question' },
    priority:       { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal', index: true },
    status:         { type: String, enum: ['open', 'in_progress', 'resolved', 'closed'], default: 'open', index: true },
    messages:       [messageSchema],
  },
  {
    timestamps: true,
    toJSON: { transform: (doc, ret) => { delete ret.__v; return ret; } },
  },
);

module.exports = mongoose.model('SupportTicket', supportTicketSchema);

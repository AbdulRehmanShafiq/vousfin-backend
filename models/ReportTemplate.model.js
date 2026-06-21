const mongoose = require('mongoose');

const layoutRowSchema = new mongoose.Schema({
  id:             { type: String, required: true },
  kind:           { type: String, enum: ['section', 'account-group', 'account', 'subtotal', 'spacer'], required: true },
  label:          { type: String, default: '' },
  accountType:    { type: String },
  accountSubtype: { type: String },
  accountIds:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount' }],
  metric:         { type: String, enum: ['balance', 'flow'], default: 'balance' },
  visible:        { type: Boolean, default: true },
}, { _id: false });

const reportTemplateSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  name:       { type: String, required: true, trim: true, maxlength: 120 },
  baseType:   { type: String, enum: ['pl', 'bs', 'custom'], default: 'custom' },
  layout:     { type: [layoutRowSchema], default: [] },
  filters:    {
    costCenterId: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
  },
  comparative: {
    enabled:    { type: Boolean, default: false },
    mode:       { type: String, enum: ['prior-period', 'prior-year', 'custom'], default: 'prior-period' },
    priorStart: { type: Date, default: null },
    priorEnd:   { type: Date, default: null },
  },
  schedule: {
    enabled:    { type: Boolean, default: false },
    frequency:  { type: String, enum: ['daily', 'weekly', 'monthly'], default: 'monthly' },
    dayOfWeek:  { type: Number, min: 0, max: 6, default: 1 },
    dayOfMonth: { type: Number, min: 1, max: 28, default: 1 },
    hour:       { type: Number, min: 0, max: 23, default: 6 },
    recipients: [{ type: String, trim: true, lowercase: true }],
    format:     { type: String, enum: ['pdf'], default: 'pdf' },
    lastRunAt:  { type: Date, default: null },
    nextRunAt:  { type: Date, default: null },
  },
  createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

reportTemplateSchema.index({ 'schedule.enabled': 1, 'schedule.nextRunAt': 1 });

module.exports = mongoose.model('ReportTemplate', reportTemplateSchema);

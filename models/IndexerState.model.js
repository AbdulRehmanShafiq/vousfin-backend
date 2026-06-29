const mongoose = require('mongoose');

const indexerStateSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      unique: true,
      index: true,
    },
    lastIndexedAt: {
      type: Date,
      default: () => new Date(0),
    },
    lastSuccessfulIndexedAt: {
      type: Date,
      default: () => new Date(0),
    },
    lastRunStartedAt: {
      type: Date,
      default: null,
    },
    lastRunCompletedAt: {
      type: Date,
      default: null,
    },
    lastRunStats: {
      indexed: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      errors: { type: Number, default: 0 },
      failedTypes: { type: [String], default: [] },
    },
    lastError: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'indexerStates',
  }
);

const IndexerState = mongoose.model('IndexerState', indexerStateSchema);

module.exports = IndexerState;

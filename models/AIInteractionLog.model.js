const mongoose = require('mongoose');

const aiInteractionLogSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    eventType: {
      type: String,
      enum: [
        'AI_QUERY',
        'AI_REFUSAL',
        'AI_FAITHFULNESS_ISSUE',
        'INDEXER_RUN',
        'INDEXER_ERROR',
        'EMBEDDING_RATE_LIMIT',
      ],
      required: true,
      index: true,
    },
    questionHash: {
      type: String,
      default: null,
      index: true,
    },
    mode: {
      type: String,
      default: null,
    },
    confident: {
      type: Boolean,
      default: null,
    },
    sources: {
      type: [
        {
          dataType: String,
          period: String,
        },
      ],
      default: [],
    },
    retrievalStats: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    collection: 'aiInteractionLogs',
  }
);

aiInteractionLogSchema.index({ businessId: 1, eventType: 1, createdAt: -1 });

const AIInteractionLog = mongoose.model('AIInteractionLog', aiInteractionLogSchema);

module.exports = AIInteractionLog;

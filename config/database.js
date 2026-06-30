const mongoose = require('mongoose');
const config = require('./');
const logger = require('./logger');

const connectDB = async () => {
  const options = {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    // Serverless tuning: keep a small pool with at least one socket always open,
    // so warm invocations reuse a live connection instead of paying the Atlas
    // TCP+TLS+auth handshake (~hundreds of ms) on every cold-ish request. A small
    // maxPoolSize is also gentle on the shared Atlas tier's connection limit.
    maxPoolSize: Number(config.MONGO_MAX_POOL_SIZE) || 10,
    minPoolSize: Number(config.MONGO_MIN_POOL_SIZE) || 1,
    // Drop idle sockets after 60s rather than holding them open forever.
    maxIdleTimeMS: 60000,
  };
  try {
    await mongoose.connect(config.MONGO_URI, options);
    logger.info('✅ MongoDB connected successfully');
    return mongoose.connection;
  } catch (error) {
    logger.error('❌ MongoDB connection error:', error.message);
    // Re-throw to let the caller handle process exit
    throw error;
  }
};

module.exports = connectDB;
const mongoose = require('mongoose');
const config = require('./');
const logger = require('./logger');

const connectDB = async () => {
  const options = {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
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
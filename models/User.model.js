// models/User.model.js
const mongoose = require('mongoose');
const { USER_ROLES, USER_STATUS, AUTH_PROVIDERS } = require('../config/constants');

const userSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: {
      type: String,
      default: null,
    },
    authProvider: {
      type: String,
      enum: Object.values(AUTH_PROVIDERS),
      required: true,
      default: AUTH_PROVIDERS.LOCAL,
    },
    googleId: {
      type: String,
      sparse: true,
      index: true,
    },
    role: {
      type: String,
      enum: Object.values(USER_ROLES),
      default: USER_ROLES.CUSTOMER,
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(USER_STATUS),
      default: USER_STATUS.PENDING,
      required: true,
      index: true,
    },
    verificationToken: {
      type: String,
      default: null,
    },
    resetPasswordToken: {
      type: String,
      default: null,
    },
    resetPasswordExpiry: {
      type: Date,
      default: null,
    },
    tokenBlacklist: {
      type: [String],
      default: [],
    },
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      default: null,
      index: true,
    },
    lastLogin: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        delete ret.passwordHash;
        delete ret.verificationToken;
        delete ret.tokenBlacklist;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Indexes
userSchema.index({ email: 1, authProvider: 1 });
userSchema.index({ status: 1, role: 1 });

// Virtuals
userSchema.virtual('isActive').get(function () {
  return this.status === USER_STATUS.ACTIVE;
});
userSchema.virtual('isSuspended').get(function () {
  return this.status === USER_STATUS.SUSPENDED;
});
userSchema.virtual('isAdmin').get(function () {
  return this.role === USER_ROLES.ADMIN;
});

// Instance methods
userSchema.methods.blacklistToken = async function (token) {
  if (!this.tokenBlacklist.includes(token)) {
    this.tokenBlacklist.push(token);
    await this.save();
  }
};
userSchema.methods.isTokenBlacklisted = function (token) {
  return this.tokenBlacklist.includes(token);
};

// Statics
userSchema.statics.findByEmail = function (email) {
  return this.findOne({ email: email.toLowerCase() });
};
userSchema.statics.findByGoogleId = function (googleId) {
  return this.findOne({ googleId });
};
userSchema.statics.findActiveCustomers = function (options = {}) {
  const { skip = 0, limit = 25, search = '' } = options;
  const query = {
    role: USER_ROLES.CUSTOMER,
    status: { $ne: USER_STATUS.DELETED },
  };
  if (search) {
    query.$or = [
      { fullName: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ];
  }
  return this.find(query).skip(skip).limit(limit).sort('-createdAt');
};

// ✅ CORRECTED PRE‑SAVE HOOK – no `next` callback, async/await style
userSchema.pre('save', async function () {
  // Only run if email was modified
  if (this.isModified('email')) {
    this.email = this.email.toLowerCase();
  }
  // No need to call next() – Mongoose will wait for the promise to resolve
});

const User = mongoose.model('User', userSchema);

module.exports = User;
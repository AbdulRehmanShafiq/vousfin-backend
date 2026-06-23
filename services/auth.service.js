// services/auth.service.js
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const userRepository = require('../repositories/user.repository');
const businessRepository = require('../repositories/business.repository');
const { hashPassword, comparePassword } = require('../utils/password.utils');
const { generateToken, blacklistToken } = require('../utils/jwt.utils');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../utils/email.utils');
const { ApiError } = require('../utils/ApiError');
const { USER_STATUS, AUTH_PROVIDERS, USER_ROLES } = require('../config/constants');
const config = require('../config');
const logger = require('../config/logger');

class AuthService {
  /**
   * Register a new user (local auth).
   * @param {Object} userData - { fullName, email, password }
   * @param {string} ipAddress
   * @returns {Promise<Object>} - Created user object (without sensitive fields)
   */
  async registerUser(userData, ipAddress) {
    const { fullName, email, password } = userData;

    // Check if user already exists
    const existingUser = await userRepository.findByEmail(email);
    if (existingUser) {
      throw new ApiError(409, 'Email already registered');
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Generate email verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');

    const skipVerification = config.SKIP_EMAIL_VERIFICATION;

    // Create user
    const user = await userRepository.create({
      fullName,
      email,
      passwordHash,
      authProvider: AUTH_PROVIDERS.LOCAL,
      role: USER_ROLES.CUSTOMER,
      status: skipVerification ? USER_STATUS.ACTIVE : USER_STATUS.PENDING,
      verificationToken: skipVerification ? null : verificationToken,
    });

    if (!skipVerification) {
      try {
        await sendVerificationEmail(email, verificationToken, fullName);
        logger.info(`Verification email sent to ${email}`);
      } catch (emailError) {
        logger.error(`Failed to send verification email to ${email}: ${emailError.message}`);
      }
    } else {
      logger.info(`User ${email} registered (email verification skipped in this environment)`);
    }

    logger.info(`New user registered: ${email} from IP ${ipAddress}`);
    return this._sanitizeUser(user);
  }

  /**
   * Resend verification email for a pending account.
   * @param {string} email
   * @param {string} ipAddress
   * @returns {Promise<void>}
   */
  async resendVerificationEmail(email, ipAddress) {
    const user = await userRepository.findByEmail(email);
    if (!user || user.status !== USER_STATUS.PENDING) {
      return;
    }
    let verificationToken = user.verificationToken;
    if (!verificationToken) {
      verificationToken = crypto.randomBytes(32).toString('hex');
      await userRepository.update(user._id, { verificationToken });
    }
    try {
      await sendVerificationEmail(email, verificationToken, user.fullName);
      logger.info(`Verification email resent to ${email} from IP ${ipAddress}`);
    } catch (emailError) {
      logger.error(`Failed to resend verification email to ${email}: ${emailError.message}`);
      throw new ApiError(500, 'Failed to send verification email. Please try again later.');
    }
  }

  /**
   * Verify email address using token.
   * @param {string} token
   * @returns {Promise<Object>} - Updated user
   */
  async verifyEmail(token) {
    const user = await userRepository.findByVerificationToken(token);
    if (!user) {
      throw new ApiError(400, 'Invalid or expired verification token');
    }
    if (user.status === USER_STATUS.ACTIVE) {
      throw new ApiError(400, 'Email already verified');
    }
    // Update user status to active and clear verification token
    const updatedUser = await userRepository.update(user._id, {
      status: USER_STATUS.ACTIVE,
      verificationToken: null,
    });
    logger.info(`User ${user.email} verified email`);
    return this._sanitizeUser(updatedUser);
  }

  /**
   * Login user with email and password.
   * @param {string} email
   * @param {string} password
   * @param {string} ipAddress
   * @returns {Promise<{user: Object, token: string}>}
   */
  async loginUser(email, password, ipAddress) {
    // Find user by email
    const user = await userRepository.findByEmail(email);
    if (!user) {
      throw new ApiError(401, 'Invalid email or password');
    }

    // Check account status
    if (user.status === USER_STATUS.SUSPENDED) {
      throw new ApiError(403, 'Your account has been suspended. Please contact support.');
    }
    if (user.status === USER_STATUS.DELETED) {
      throw new ApiError(403, 'Your account has been deleted.');
    }
    if (user.status === USER_STATUS.PENDING) {
      if (config.SKIP_EMAIL_VERIFICATION) {
        await userRepository.update(user._id, {
          status: USER_STATUS.ACTIVE,
          verificationToken: null,
        });
        user.status = USER_STATUS.ACTIVE;
      } else {
        throw new ApiError(403, 'Please verify your email before logging in.');
      }
    }

    // Verify password (only for local accounts)
    if (user.authProvider !== AUTH_PROVIDERS.LOCAL) {
      throw new ApiError(401, `Please login using ${user.authProvider} OAuth.`);
    }
    const isPasswordValid = await comparePassword(password, user.passwordHash);
    if (!isPasswordValid) {
      // Track failed attempts (optional – for lockout logic, you can add attempt counter)
      throw new ApiError(401, 'Invalid email or password');
    }

    // If user has MFA enabled, return a short-lived challenge token instead of the full JWT.
    if (user.mfa?.enabled) {
      const mfaToken = jwt.sign(
        { mfaChallenge: true, userId: user._id.toString() },
        config.JWT_SECRET,
        { expiresIn: '5m' }
      );
      logger.info(`User ${email} requires MFA from IP ${ipAddress}`);
      return { mfaRequired: true, mfaToken };
    }

    // Generate JWT
    const token = generateToken(user._id, user.role);

    // Update last login timestamp
    await userRepository.update(user._id, { lastLogin: new Date() });

    const freshUser = await userRepository.findActiveById(user._id);

    logger.info(`User ${email} logged in from IP ${ipAddress}`);
    return {
      user: this._sanitizeUser(freshUser),
      token,
    };
  }

  /**
   * Return current authenticated user profile (includes businessId).
   * Also lazily self-heals the owner membership so existing owners get a
   * membership row on first profile load after Phase 6A is deployed.
   */
  async getProfile(userId) {
    const user = await userRepository.findActiveById(userId);
    if (!user) {
      throw new ApiError(401, 'User account not found or has been deleted.');
    }
    if (user.businessId) {
      try {
        await require('./membership.service').ensureOwnerMembership(user.businessId, user._id);
      } catch (err) {
        logger.warn(`[auth] ensureOwnerMembership failed for user ${userId}: ${err.message}`);
      }
    }
    return this._sanitizeUser(user);
  }

  /**
   * Logout user – blacklist the token.
   * @param {string} userId
   * @param {string} token
   * @param {string} ipAddress
   * @returns {Promise<void>}
   */
  async logoutUser(userId, token, ipAddress) {
    await userRepository.addToBlacklist(userId, token);
    logger.info(`User ${userId} logged out from IP ${ipAddress}`);
  }

  /**
   * Request password reset – sends email with reset link.
   * @param {string} email
   * @returns {Promise<void>}
   */
  async requestPasswordReset(email) {
    const user = await userRepository.findByEmail(email);
    if (!user || user.authProvider !== AUTH_PROVIDERS.LOCAL) {
      // For security, don't reveal if email exists – always return success.
      return;
    }
    const resetToken = crypto.randomBytes(32).toString('hex');
    // Store reset token with expiry (you need to add resetToken and resetTokenExpiry fields to User model)
    await userRepository.update(user._id, {
      resetPasswordToken: resetToken,
      resetPasswordExpiry: new Date(Date.now() + 3600000), // 1 hour
    });
    try {
      await sendPasswordResetEmail(email, resetToken, user.fullName);
      logger.info(`Password reset email sent to ${email}`);
    } catch (err) {
      logger.error(`Failed to send reset email to ${email}: ${err.message}`);
    }
  }

  /**
   * Reset password using token.
   * @param {string} token
   * @param {string} newPassword
   * @returns {Promise<void>}
   */
  async resetPassword(token, newPassword) {
    const user = await userRepository.findOne({
      resetPasswordToken: token,
      resetPasswordExpiry: { $gt: new Date() },
    });
    if (!user) {
      throw new ApiError(400, 'Invalid or expired reset token');
    }
    const hashed = await hashPassword(newPassword);
    await userRepository.update(user._id, {
      passwordHash: hashed,
      resetPasswordToken: null,
      resetPasswordExpiry: null,
    });
    logger.info(`Password reset for user ${user.email}`);
  }

  /**
   * Handle Google OAuth login/registration.
   * @param {Object} profile - Google profile from Passport
   * @returns {Promise<{user: Object, isNew: boolean}>}
   */
  async handleGoogleOAuth(profile) {
    const { id: googleId, emails, displayName } = profile;
    const email = emails[0].value;

    let user = await userRepository.findByGoogleId(googleId);
    if (user) {
      return { user: this._sanitizeUser(user), isNew: false };
    }

    // Check if email exists (maybe registered with local)
    user = await userRepository.findByEmail(email);
    if (user) {
      if (user.authProvider === AUTH_PROVIDERS.LOCAL) {
        // Link Google account to existing local user (you can implement later)
        throw new ApiError(409, 'Email already registered with password. Please login normally.');
      }
    } else {
      // Create new user
      user = await userRepository.create({
        fullName: displayName,
        email,
        authProvider: AUTH_PROVIDERS.GOOGLE,
        googleId,
        role: USER_ROLES.CUSTOMER,
        status: USER_STATUS.ACTIVE, // Google users are pre-verified
      });
      logger.info(`New user created via Google OAuth: ${email}`);
      return { user: this._sanitizeUser(user), isNew: true };
    }
    return { user: this._sanitizeUser(user), isNew: false };
  }

  /**
   * Issue a JWT for an authenticated user (e.g. OAuth callback).
   * @param {Object} user - Mongoose user document or plain object with _id/id and role
   * @returns {string}
   */
  generateTokenForUser(user) {
    const userId = user._id || user.id;
    return generateToken(userId, user.role);
  }

  /**
   * Remove sensitive fields from user object.
   * @param {Object} user
   * @returns {Object}
   * @private
   */
  _sanitizeUser(user) {
    if (!user) return null;
    const { passwordHash, verificationToken, tokenBlacklist, ...safeUser } = user.toObject ? user.toObject() : user;
    return safeUser;
  }
}

module.exports = new AuthService();
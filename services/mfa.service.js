// services/mfa.service.js
// TOTP Multi-Factor Authentication service (NFR-SEC-01)
// Backup codes stored as plaintext — for production consider hashing with bcrypt.
const { authenticator } = require('otplib');
const crypto = require('crypto');
const User = require('../models/User.model');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');

class MfaService {
  /**
   * Begin MFA setup for a user.
   * Generates a TOTP secret + 8 backup codes, persists them (un-confirmed),
   * and returns the setup data so the client can render a QR code.
   */
  async generateSetup(userId) {
    const user = await User.findById(userId).select('+mfa.secret +mfa.backupCodes +mfa.enabled');
    if (!user) throw new ApiError(404, 'User not found');
    if (user.mfa?.enabled) throw new ApiError(400, 'MFA is already enabled. Disable it first to re-enrol.');

    const secret = authenticator.generateSecret();
    // 8 backup codes — 8 hex bytes each = 16 char strings
    const backupCodes = Array.from({ length: 8 }, () => crypto.randomBytes(4).toString('hex'));
    const otpauthUrl = authenticator.keyuri(user.email, 'VousFin', secret);

    user.mfa = { enabled: false, secret, backupCodes };
    await user.save();

    logger.info(`[mfa] setup initiated for user ${userId}`);
    return { secret, backupCodes, otpauthUrl };
  }

  /**
   * Confirm TOTP enrolment by verifying the first code from the authenticator app.
   * Sets mfa.enabled = true.
   */
  async confirmEnrollment(userId, token) {
    const user = await User.findById(userId).select('+mfa.secret +mfa.backupCodes +mfa.enabled');
    if (!user) throw new ApiError(404, 'User not found');
    if (!user.mfa?.secret) throw new ApiError(400, 'Setup not started. Call /auth/mfa/setup first.');

    const valid = authenticator.verify({ token: String(token), secret: user.mfa.secret });
    if (!valid) throw new ApiError(400, 'Invalid code. Check the 6-digit code in your authenticator app.');

    user.mfa.enabled = true;
    await user.save();

    logger.info(`[mfa] enrolled for user ${userId}`);
    return { enabled: true };
  }

  /**
   * Verify a TOTP token (or backup code) for a user.
   * Returns true if valid, false if not.
   * If MFA is not enrolled, always returns true (pass-through).
   */
  async verifyToken(userId, token) {
    const user = await User.findById(userId).select('+mfa.secret +mfa.backupCodes +mfa.enabled');
    if (!user) throw new ApiError(404, 'User not found');

    // MFA not enrolled — let them through
    if (!user.mfa?.enabled) return true;

    // Check TOTP
    const totpValid = authenticator.verify({ token: String(token), secret: user.mfa.secret });
    if (totpValid) return true;

    // Check backup codes
    const codeIndex = (user.mfa.backupCodes || []).indexOf(String(token));
    if (codeIndex !== -1) {
      // Consume the backup code (one-time use)
      user.mfa.backupCodes.splice(codeIndex, 1);
      await user.save();
      logger.info(`[mfa] backup code consumed for user ${userId}`);
      return true;
    }

    return false;
  }

  /**
   * Disable MFA after verifying the current TOTP code.
   */
  async disableMFA(userId, token) {
    const valid = await this.verifyToken(userId, token);
    if (!valid) throw new ApiError(401, 'Invalid code. Cannot disable MFA.');

    const user = await User.findById(userId).select('+mfa.secret +mfa.backupCodes +mfa.enabled');
    if (!user) throw new ApiError(404, 'User not found');

    user.mfa = { enabled: false, secret: null, backupCodes: [] };
    await user.save();

    logger.info(`[mfa] disabled for user ${userId}`);
    return { enabled: false };
  }
}

module.exports = new MfaService();

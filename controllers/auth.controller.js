// controllers/auth.controller.js
const jwt = require('jsonwebtoken');
const authService = require('../services/auth.service');
// mfaService is lazy-required inside MFA handlers to avoid ESM parse issues in Jest
// when the module is loaded in unit tests that don't use MFA.
const ApiResponse = require('../utils/ApiResponse');
const { ApiError } = require('../utils/ApiError');
const config = require('../config');
const logger = require('../config/logger');

/**
 * Register a new user (local).
 * POST /api/v1/auth/register
 */
const register = async (req, res, next) => {
  try {
    const { fullName, email, password } = req.body;
    const user = await authService.registerUser({ fullName, email, password }, req.ip);
    const token = authService.generateTokenForUser(user);

    res.cookie('token', token, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: config.NODE_ENV === 'production' ? 'strict' : 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    });

    const message = config.SKIP_EMAIL_VERIFICATION
      ? 'Registration successful. You are now signed in.'
      : 'Registration successful. Please check your email for verification.';

    ApiResponse.created(res, { user, token }, message);
  } catch (error) {
    next(error);
  }
};

/**
 * Login user (local).
 * POST /api/v1/auth/login
 * Sets JWT in HTTP‑only cookie and returns token in response body.
 */
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const result = await authService.loginUser(email, password, req.ip);

    // MFA challenge — client must call /auth/mfa/verify with the short-lived token
    if (result.mfaRequired) {
      return ApiResponse.success(res, { mfaRequired: true, mfaToken: result.mfaToken }, 'MFA required');
    }

    const { user, token } = result;

    // Set JWT as HTTP‑only cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: config.NODE_ENV === 'production' ? 'strict' : 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    });

    ApiResponse.success(res, { user, token }, 'Login successful');
  } catch (error) {
    next(error);
  }
};

/**
 * Complete MFA login challenge.
 * POST /api/v1/auth/mfa/verify
 */
const mfaVerify = async (req, res, next) => {
  try {
    const mfaService = require('../services/mfa.service');
    const { mfaToken, token } = req.body;
    if (!mfaToken || !token) throw new ApiError(400, 'mfaToken and token are required');

    let decoded;
    try {
      decoded = jwt.verify(mfaToken, config.JWT_SECRET);
    } catch {
      throw new ApiError(401, 'MFA session expired. Please log in again.');
    }
    if (!decoded.mfaChallenge) throw new ApiError(401, 'Invalid MFA token.');

    const valid = await mfaService.verifyToken(decoded.userId, token);
    if (!valid) throw new ApiError(401, 'Invalid authenticator code.');

    // Issue the full JWT now that MFA is satisfied
    const userRepository = require('../repositories/user.repository');
    await userRepository.update(decoded.userId, { lastLogin: new Date() });
    const user = await userRepository.findActiveById(decoded.userId);
    const fullToken = authService.generateTokenForUser(user);

    res.cookie('token', fullToken, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: config.NODE_ENV === 'production' ? 'strict' : 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    });

    ApiResponse.success(res, { user: authService._sanitizeUser(user), token: fullToken }, 'Login successful');
  } catch (error) {
    next(error);
  }
};

/**
 * Start MFA setup (generate secret + backup codes).
 * GET /api/v1/auth/mfa/setup
 */
const mfaSetup = async (req, res, next) => {
  try {
    const mfaService = require('../services/mfa.service');
    const data = await mfaService.generateSetup(req.user.id);
    ApiResponse.success(res, data, 'MFA setup initiated');
  } catch (error) {
    next(error);
  }
};

/**
 * Confirm MFA enrolment with first TOTP code.
 * POST /api/v1/auth/mfa/confirm
 */
const mfaConfirm = async (req, res, next) => {
  try {
    const mfaService = require('../services/mfa.service');
    const { token } = req.body;
    if (!token) throw new ApiError(400, 'token is required');
    const data = await mfaService.confirmEnrollment(req.user.id, token);
    ApiResponse.success(res, data, 'MFA enabled successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Disable MFA (requires current TOTP code to confirm).
 * DELETE /api/v1/auth/mfa
 */
const mfaDisable = async (req, res, next) => {
  try {
    const mfaService = require('../services/mfa.service');
    const { token } = req.body;
    if (!token) throw new ApiError(400, 'token is required');
    const data = await mfaService.disableMFA(req.user.id, token);
    ApiResponse.success(res, data, 'MFA disabled');
  } catch (error) {
    next(error);
  }
};

/**
 * Verify email address using token.
 * POST /api/v1/auth/verify-email
 */
const verifyEmail = async (req, res, next) => {
  try {
    const { token } = req.body;
    const user = await authService.verifyEmail(token);
    ApiResponse.success(res, user, 'Email verified successfully. You can now log in.');
  } catch (error) {
    next(error);
  }
};

/**
 * Resend verification email.
 * POST /api/v1/auth/resend-verification
 */
const resendVerification = async (req, res, next) => {
  try {
    const { email } = req.body;
    // This method should be implemented in authService if needed
    // For now, we re‑send verification if user exists and is pending
    // Placeholder – implement in authService.resendVerification
    await authService.resendVerificationEmail(email, req.ip);
    ApiResponse.success(res, null, 'Verification email resent. Please check your inbox.');
  } catch (error) {
    next(error);
  }
};

/**
 * Logout user – blacklist JWT.
 * POST /api/v1/auth/logout
 */
/**
 * Get current authenticated user (refreshes businessId from DB).
 * GET /api/v1/auth/me
 */
const getMe = async (req, res, next) => {
  try {
    const user = await authService.getProfile(req.user.id);
    ApiResponse.success(res, user, 'Profile retrieved');
  } catch (error) {
    next(error);
  }
};

const logout = async (req, res, next) => {
  try {
    const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
    if (!token) {
      throw new ApiError(400, 'No token provided');
    }
    await authService.logoutUser(req.user.id, token, req.ip);
    
    // Clear cookie
    res.clearCookie('token', {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'strict',
    });
    
    ApiResponse.success(res, null, 'Logged out successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Request password reset (send email).
 * POST /api/v1/auth/forgot-password
 */
const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    await authService.requestPasswordReset(email);
    // Always return success even if email not found (security)
    ApiResponse.success(res, null, 'If an account exists, a password reset link has been sent to your email.');
  } catch (error) {
    next(error);
  }
};

/**
 * Reset password using token.
 * POST /api/v1/auth/reset-password
 */
const resetPassword = async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;
    await authService.resetPassword(token, newPassword);
    ApiResponse.success(res, null, 'Password reset successful. You can now log in.');
  } catch (error) {
    next(error);
  }
};

/**
 * Google OAuth – redirect to Google.
 * GET /api/v1/auth/google
 * This is handled by Passport. We just need a controller that calls passport.authenticate.
 * However, this file may not contain the route handler directly; the route will use passport.authenticate.
 * For completeness, we provide a placeholder.
 */
const googleAuth = (req, res, next) => {
  // Actual implementation is in the route: passport.authenticate('google', { scope: ['profile', 'email'] })
  // This controller is not needed if using Passport middleware directly.
  // We'll keep as a stub.
  next(new ApiError(501, 'Google OAuth not implemented in this controller – use Passport middleware'));
};

/**
 * Google OAuth callback.
 * GET /api/v1/auth/google/callback
 * After Google redirects, Passport calls this.
 */
const googleCallback = async (req, res, next) => {
  try {
    // Passport attaches user to req.user
    if (!req.user) {
      throw new ApiError(401, 'Google authentication failed');
    }
    const token = authService.generateTokenForUser(req.user); // You'll need to add this method or use existing
    // Set cookie and redirect to frontend
    res.cookie('token', token, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
    });
    res.redirect(`${config.CLIENT_URL}/dashboard`);
  } catch (error) {
    next(error);
  }
};

/**
 * Refresh token (optional).
 * POST /api/v1/auth/refresh
 */
const refreshToken = async (req, res, next) => {
  try {
    const oldToken = req.cookies.token || req.headers.authorization?.split(' ')[1];
    if (!oldToken) throw new ApiError(401, 'No token provided');
    // Implementation: verify old token, blacklist it, generate new one
    // This is optional and can be added later.
    throw new ApiError(501, 'Token refresh not implemented');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  register,
  login,
  getMe,
  verifyEmail,
  resendVerification,
  logout,
  forgotPassword,
  resetPassword,
  googleAuth,
  googleCallback,
  refreshToken,
  mfaVerify,
  mfaSetup,
  mfaConfirm,
  mfaDisable,
};
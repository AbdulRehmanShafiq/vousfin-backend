const express = require('express');
const passport = require('../../config/passport');
const router = express.Router();
const authController = require('../../controllers/auth.controller');
const validate = require('../../middleware/validate.middleware');
const {
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  resendVerificationSchema,
} = require('../../validations/auth.validation');
const { authMiddleware } = require('../../middleware/auth.middleware');
const config = require('../../config');

router.post('/register', validate(registerSchema), authController.register);
router.post('/login', validate(loginSchema), authController.login);
router.get('/me', authMiddleware, authController.getMe);
router.post('/verify-email', validate(verifyEmailSchema), authController.verifyEmail);
router.post('/resend-verification', validate(resendVerificationSchema), authController.resendVerification);
router.post('/logout', authMiddleware, authController.logout);
router.post('/forgot-password', validate(forgotPasswordSchema), authController.forgotPassword);
router.post('/reset-password', validate(resetPasswordSchema), authController.resetPassword);

// MFA routes — NFR-SEC-01
// /auth/mfa/verify is public (called before full auth is established)
router.post('/mfa/verify', authController.mfaVerify);
// These 3 require normal auth
router.get('/mfa/setup', authMiddleware, authController.mfaSetup);
router.post('/mfa/confirm', authMiddleware, authController.mfaConfirm);
router.delete('/mfa', authMiddleware, authController.mfaDisable);

// Google OAuth
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
router.get(
  '/google/callback',
  passport.authenticate('google', { failureRedirect: `${config.CLIENT_URL}/login?error=google`, session: false }),
  authController.googleCallback
);

module.exports = router;
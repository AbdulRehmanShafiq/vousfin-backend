// validations/auth.validation.js
const Joi = require('joi');
const { PASSWORD_REGEX, USER_ROLES } = require('../config/constants');

/**
 * Registration schema (local)
 * - fullName: min 2, max 100, required
 * - email: valid email format, required
 * - password: matches regex (uppercase, number, special char, min 8), required
 */
const registerSchema = Joi.object({
  fullName: Joi.string().min(2).max(100).required().messages({
    'string.min': 'Full name must be at least 2 characters',
    'string.max': 'Full name cannot exceed 100 characters',
    'any.required': 'Full name is required',
  }),
  email: Joi.string().email().required().messages({
    'string.email': 'Please provide a valid email address',
    'any.required': 'Email is required',
  }),
  password: Joi.string().pattern(PASSWORD_REGEX).required().messages({
    'string.pattern.base':
      'Password must be at least 8 characters and include uppercase, lowercase, a number, and a symbol (e.g. Uzair123@)',
    'any.required': 'Password is required',
  }),
});

/**
 * Login schema (local)
 * - email: valid email format, required
 * - password: required (no format validation on login, just presence)
 */
const loginSchema = Joi.object({
  email: Joi.string().email().required().messages({
    'string.email': 'Please provide a valid email address',
    'any.required': 'Email is required',
  }),
  password: Joi.string().required().messages({
    'any.required': 'Password is required',
  }),
});

/**
 * Email verification schema
 * - token: required string (JWT or random token from email)
 */
const verifyEmailSchema = Joi.object({
  token: Joi.string().required().messages({
    'any.required': 'Verification token is required',
  }),
});

/**
 * Forgot password (request reset) schema
 * - email: valid email format, required
 */
const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().required().messages({
    'string.email': 'Please provide a valid email address',
    'any.required': 'Email is required',
  }),
});

/**
 * Reset password schema
 * - token: required string
 * - newPassword: must match password regex (same as registration)
 * - confirmPassword: must match newPassword
 */
const resetPasswordSchema = Joi.object({
  token: Joi.string().required().messages({
    'any.required': 'Reset token is required',
  }),
  newPassword: Joi.string().pattern(PASSWORD_REGEX).required().messages({
    'string.pattern.base':
      'Password must be at least 8 characters and include uppercase, lowercase, a number, and a symbol',
    'any.required': 'New password is required',
  }),
  confirmPassword: Joi.string().valid(Joi.ref('newPassword')).required().messages({
    'any.only': 'Passwords do not match',
    'any.required': 'Please confirm your password',
  }),
});

/**
 * Resend verification email schema
 * - email: valid email format, required
 */
const resendVerificationSchema = Joi.object({
  email: Joi.string().email().required().messages({
    'string.email': 'Please provide a valid email address',
    'any.required': 'Email is required',
  }),
});

/**
 * Google OAuth callback schema (minimal – token is usually in query)
 * - code: optional (handled by Passport)
 * For direct token exchange (if used), we may validate nothing.
 */
const googleAuthSchema = Joi.object({
  code: Joi.string().optional(),
});

module.exports = {
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  resendVerificationSchema,
  googleAuthSchema,
};
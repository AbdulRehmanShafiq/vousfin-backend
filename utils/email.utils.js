// utils/email.utils.js
const nodemailer = require('nodemailer');
const config = require('../config');
const logger = require('../config/logger');

/**
 * Create a reusable transporter if email is enabled.
 * Returns null if email is not configured.
 */
const getTransporter = () => {
  if (!config.EMAIL_ENABLED) {
    logger.warn('Email service not configured – skipping email send');
    return null;
  }
  return nodemailer.createTransport({
    host: config.SMTP.host,
    port: config.SMTP.port,
    secure: config.SMTP.secure,
    auth: {
      user: config.SMTP.auth.user,
      pass: config.SMTP.auth.pass,
    },
  });
};

/**
 * Generic email sender.
 * @param {Object} options - { to, subject, html }
 * @returns {Promise<void>}
 */
const sendEmail = async (options) => {
  const transporter = getTransporter();
  if (!transporter) return; // Silently skip if email disabled

  const mailOptions = {
    from: config.EMAIL_FROM,
    to: options.to,
    subject: options.subject,
    html: options.html,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    logger.info(`Email sent to ${options.to}: ${info.messageId}`);
  } catch (error) {
    logger.error(`Failed to send email to ${options.to}: ${error.message}`);
    throw new Error(`Email sending failed: ${error.message}`);
  }
};

/**
 * Send email verification link.
 * @param {string} to - Recipient email address
 * @param {string} verificationToken - JWT or random token (24-hour expiry)
 * @param {string} fullName - User's full name
 * @returns {Promise<void>}
 */
const sendVerificationEmail = async (to, verificationToken, fullName) => {
  const verificationLink = `${config.CLIENT_URL}/verify-email?token=${verificationToken}`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px; }
        .button { display: inline-block; padding: 10px 20px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 4px; }
        .footer { margin-top: 20px; font-size: 12px; color: #777; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>Welcome to vousFin, ${fullName}!</h2>
        <p>Please verify your email address to activate your account.</p>
        <p><a href="${verificationLink}" class="button">Verify Email</a></p>
        <p>Or copy and paste this link in your browser:</p>
        <p>${verificationLink}</p>
        <p>This link expires in 24 hours.</p>
        <div class="footer">
          <p>vousFin – Your Personal Smart Accountant</p>
        </div>
      </div>
    </body>
    </html>
  `;
  await sendEmail({
    to,
    subject: 'Verify your email – vousFin',
    html,
  });
};

/**
 * Send account status notification (suspended / reinstated / deleted).
 * @param {string} to - User email
 * @param {string} fullName - User's full name
 * @param {string} status - 'suspended', 'reinstated', 'deleted'
 * @param {string} reason - Optional reason for suspension/deletion
 * @returns {Promise<void>}
 */
const sendAccountStatusEmail = async (to, fullName, status, reason = '') => {
  let subject = '';
  let bodyText = '';
  switch (status) {
    case 'suspended':
      subject = 'Account Suspended – vousFin';
      bodyText = `Your account has been suspended. ${reason ? `Reason: ${reason}` : 'Please contact support for more information.'}`;
      break;
    case 'reinstated':
      subject = 'Account Reinstated – vousFin';
      bodyText = 'Your account has been reinstated. You can now log in again.';
      break;
    case 'deleted':
      subject = 'Account Deleted – vousFin';
      bodyText = 'Your account has been permanently deleted.';
      break;
    default:
      logger.warn(`Unknown account status email type: ${status}`);
      return;
  }
  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body>
      <div style="max-width:600px; margin:0 auto; padding:20px;">
        <h2>Dear ${fullName},</h2>
        <p>${bodyText}</p>
        <p>If you did not expect this action, please contact our support team immediately.</p>
        <hr>
        <p>vousFin – Smart Accounting</p>
      </div>
    </body>
    </html>
  `;
  await sendEmail({ to, subject, html });
};

/**
 * Send password reset link (placeholder – to be implemented when password reset feature is added).
 * @param {string} to - User email
 * @param {string} resetToken - Password reset token
 * @param {string} fullName - User's full name
 * @returns {Promise<void>}
 */
const sendPasswordResetEmail = async (to, resetToken, fullName) => {
  const resetLink = `${config.CLIENT_URL}/reset-password?token=${resetToken}`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body>
      <div style="max-width:600px; margin:0 auto; padding:20px;">
        <h2>Password Reset Request</h2>
        <p>Hello ${fullName},</p>
        <p>You requested to reset your password. Click the link below to proceed:</p>
        <p><a href="${resetLink}">Reset Password</a></p>
        <p>This link expires in 1 hour.</p>
        <p>If you did not request this, please ignore this email.</p>
        <hr>
        <p>vousFin</p>
      </div>
    </body>
    </html>
  `;
  await sendEmail({ to, subject: 'Reset your vousFin password', html });
};

module.exports = {
  sendVerificationEmail,
  sendAccountStatusEmail,
  sendPasswordResetEmail,
};
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
    ...(options.attachments ? { attachments: options.attachments } : {}),
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

/**
 * Send reorder request to a vendor when an inventory item drops to/below
 * its reorder level.  Best-effort — silently no-ops if email is disabled
 * or vendor email is missing.
 *
 * @param {Object} opts
 * @param {string} opts.to           Vendor email
 * @param {string} opts.vendorName
 * @param {string} opts.itemName
 * @param {string} [opts.sku]
 * @param {number} opts.currentStock
 * @param {number} opts.reorderLevel
 * @param {number} opts.reorderQty
 * @param {string} opts.unit
 * @param {string} opts.businessName
 * @param {string} [opts.businessEmail]
 */
const sendReorderRequestEmail = async (opts) => {
  if (!opts.to) {
    logger.warn(`[reorder] No vendor email — skipping reorder notification for "${opts.itemName}"`);
    return;
  }
  const subject = `Reorder Request: ${opts.itemName}${opts.sku ? ` (${opts.sku})` : ''}`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8">
      <style>
        body { font-family: Arial, sans-serif; color: #1F2937; line-height: 1.6; }
        .container { max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #E5E7EB; border-radius: 8px; }
        .header { color: #0891B2; }
        table { width: 100%; border-collapse: collapse; margin: 16px 0; }
        th, td { text-align: left; padding: 8px; border-bottom: 1px solid #E5E7EB; }
        th { background: #F8FAFC; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748B; }
        .alert { background: #FEF2F2; border-left: 4px solid #DC2626; padding: 12px; margin: 16px 0; color: #991B1B; }
        .footer { margin-top: 20px; font-size: 12px; color: #64748B; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2 class="header">Reorder Request — ${opts.itemName}</h2>
        <p>Dear ${opts.vendorName || 'Supplier'},</p>
        <p>This is an automated notification from <strong>${opts.businessName || 'our team'}</strong>. Stock for the item below has reached its reorder threshold and we'd like to place a fresh order.</p>

        <table>
          <tr><th>Item</th><td>${opts.itemName}</td></tr>
          ${opts.sku ? `<tr><th>SKU</th><td>${opts.sku}</td></tr>` : ''}
          <tr><th>Current Stock</th><td>${opts.currentStock} ${opts.unit || 'units'}</td></tr>
          <tr><th>Reorder Level</th><td>${opts.reorderLevel} ${opts.unit || 'units'}</td></tr>
          <tr><th>Requested Quantity</th><td><strong>${opts.reorderQty || '—'} ${opts.unit || 'units'}</strong></td></tr>
        </table>

        ${opts.currentStock === 0 ? `<div class="alert"><strong>⚠ Out of stock.</strong> Please prioritise this order.</div>` : ''}

        <p>Please confirm availability, pricing, and expected lead time at your earliest convenience.</p>

        ${opts.businessEmail ? `<p>Reply to: <a href="mailto:${opts.businessEmail}">${opts.businessEmail}</a></p>` : ''}

        <div class="footer">
          <p>This is an automated reorder alert generated by vousFin Smart Accountant.</p>
        </div>
      </div>
    </body>
    </html>
  `;
  try {
    await sendEmail({ to: opts.to, subject, html });
    logger.info(`[reorder] Notification sent to ${opts.to} for "${opts.itemName}"`);
  } catch (err) {
    // Best-effort — never fail the originating transaction
    logger.error(`[reorder] Email failed for "${opts.itemName}": ${err.message}`);
  }
};

/**
 * Send a customer payment reminder for an outstanding invoice.
 *
 * @param {Object} opts
 * @param {string} opts.to                 customer email
 * @param {string} opts.customerName
 * @param {string} opts.invoiceNumber
 * @param {Date}   opts.dueDate
 * @param {number} opts.totalAmount
 * @param {number} opts.remainingBalance
 * @param {string} opts.currencyCode
 * @param {string} opts.cadenceLabel       "Payment due today" | "First overdue notice" | ...
 * @param {string} opts.tone               'reminder' | 'first_notice' | 'second_notice' | 'final_notice'
 * @param {string} opts.businessName
 * @param {string} [opts.businessEmail]
 * @param {string} [opts.businessPhone]
 */
const sendCustomerPaymentReminderEmail = async (opts) => {
  if (!opts.to) return;

  const TONES = {
    reminder:      { color: '#0891B2', subject: 'Payment Reminder',  intro: 'This is a friendly reminder' },
    first_notice:  { color: '#D97706', subject: 'Overdue Invoice',   intro: 'Our records show your invoice is now past due' },
    second_notice: { color: '#DC2626', subject: 'Second Notice — Overdue Invoice', intro: 'This is our second notice that your invoice is overdue' },
    final_notice:  { color: '#991B1B', subject: 'Final Notice — Overdue Invoice', intro: 'This is our FINAL notice for the invoice below. Please remit payment immediately to avoid further action' },
  };
  const t = TONES[opts.tone] || TONES.reminder;

  const fmt = (v) => `${opts.currencyCode || 'PKR'} ${(Number(v) || 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const dueStr = opts.dueDate ? new Date(opts.dueDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

  const subject = `${t.subject}: Invoice ${opts.invoiceNumber}`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8">
      <style>
        body { font-family: Arial, sans-serif; color: #1F2937; line-height: 1.6; }
        .container { max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #E5E7EB; border-radius: 8px; }
        .header { color: ${t.color}; border-bottom: 3px solid ${t.color}; padding-bottom: 12px; margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; margin: 16px 0; }
        th, td { text-align: left; padding: 10px; border-bottom: 1px solid #E5E7EB; }
        th { background: #F8FAFC; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748B; }
        .total-row { font-weight: bold; font-size: 16px; color: ${t.color}; }
        .footer { margin-top: 24px; font-size: 12px; color: #64748B; border-top: 1px solid #E5E7EB; padding-top: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2 class="header">${t.subject}</h2>
        <p>Dear ${opts.customerName || 'Customer'},</p>
        <p>${t.intro} regarding the invoice below issued by <strong>${opts.businessName || 'our business'}</strong>.</p>

        <table>
          <tr><th>Invoice Number</th><td>${opts.invoiceNumber}</td></tr>
          <tr><th>Original Amount</th><td>${fmt(opts.totalAmount)}</td></tr>
          <tr><th>Due Date</th><td>${dueStr}</td></tr>
          <tr class="total-row"><th>Balance Due</th><td>${fmt(opts.remainingBalance)}</td></tr>
        </table>

        <p>Please arrange payment at your earliest convenience. If you have already paid, please disregard this notice.</p>

        ${opts.businessEmail || opts.businessPhone ? `
        <p><strong>Questions?</strong><br>
          ${opts.businessEmail ? `Email: <a href="mailto:${opts.businessEmail}">${opts.businessEmail}</a><br>` : ''}
          ${opts.businessPhone ? `Phone: ${opts.businessPhone}` : ''}
        </p>` : ''}

        <div class="footer">
          <p>This is an automated reminder generated by vousFin Smart Accountant on behalf of ${opts.businessName || 'our business'}.</p>
        </div>
      </div>
    </body>
    </html>
  `;
  try {
    await sendEmail({ to: opts.to, subject, html });
    logger.info(`[reminder] ${t.subject} sent to ${opts.to} for invoice ${opts.invoiceNumber}`);
  } catch (err) {
    logger.error(`[reminder] Email failed for invoice ${opts.invoiceNumber}: ${err.message}`);
  }
};

/**
 * Send a team invitation email to a new team member.
 * Best-effort — the invite row is already persisted; a failed email can be resent.
 *
 * @param {string} to           Recipient email address
 * @param {string} inviteToken  Secure random token for the accept-invite link
 * @param {string} businessName Display name of the business
 * @param {string[]} roles      Array of role strings granted to the invitee
 * @returns {Promise<void>}
 */
const sendTeamInviteEmail = async (to, inviteToken, businessName, roles) => {
  // CLIENT_URL may be comma-separated; use the first origin for the link base.
  const base = String(config.CLIENT_URL || '').split(',')[0].trim();
  const acceptLink = `${base}/accept-invite?token=${inviteToken}`;
  const roleText = (roles || []).join(', ');
  const html = `
    <!DOCTYPE html><html><head><meta charset="UTF-8"></head>
    <body><div style="max-width:600px;margin:0 auto;padding:20px;">
      <h2>You've been invited to ${businessName} on vousFin</h2>
      <p>You've been added as: <b>${roleText}</b>.</p>
      <p>Click below to join the team and set up your access:</p>
      <p><a href="${acceptLink}">Accept invitation</a></p>
      <p>This invitation expires in 7 days.</p>
      <hr><p>vousFin</p>
    </div></body></html>`;
  await sendEmail({ to, subject: `You're invited to ${businessName} on vousFin`, html });
};

module.exports = {
  sendEmail,
  sendVerificationEmail,
  sendAccountStatusEmail,
  sendPasswordResetEmail,
  sendReorderRequestEmail,
  sendCustomerPaymentReminderEmail,
  sendTeamInviteEmail,
};
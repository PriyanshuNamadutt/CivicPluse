const axios = require('axios');

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

if (!BREVO_API_KEY) {
  console.error('[Brevo] ❌ BREVO_API_KEY is missing from environment variables');
}

const FROM_EMAIL = process.env.BREVO_FROM_EMAIL || 'no-reply@example.com';
const FROM_NAME  = process.env.BREVO_FROM_NAME  || 'CivicPulse';

/**
 * Low-level sender — posts to Brevo's transactional email endpoint.
 * Throws on failure so callers can catch/log/handle as before.
 */
const sendViaBrevo = async ({ to, subject, html, text, replyTo, attachments }) => {
  const payload = {
    sender: { email: FROM_EMAIL, name: FROM_NAME },
    to: [{ email: to }],
    subject,
    htmlContent: html,
  };

  if (text) payload.textContent = text;
  if (replyTo) payload.replyTo = { email: replyTo };

  // Brevo expects attachments as base64 content + name
  if (attachments && attachments.length) {
    payload.attachment = attachments.map(a => ({
      name: a.filename,
      content: a.content // must already be base64 string (no data: prefix)
    }));
  }

  try {
    const res = await axios.post(BREVO_API_URL, payload, {
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 15000
    });
    // Brevo returns { messageId: "<...>" } on success
    return { id: res.data?.messageId };
  } catch (err) {
    const apiError = err.response?.data;
    console.error('[Brevo] Send failed:', apiError || err.message);
    throw new Error(apiError?.message || err.message || 'Failed to send email via Brevo');
  }
};

/**
 * Send OTP email for verification
 */
const sendOTPEmail = async (email, otp, purpose) => {
  const purposeText =
    purpose === 'email_verification'  ? 'Email Verification'          :
    purpose === 'issue_reporting'     ? 'Issue Reporting Verification' :
                                        'Password Reset';

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>CivicPulse OTP</title></head>
    <body style="font-family: 'Segoe UI', sans-serif; background: #f0f4f8; margin: 0; padding: 20px;">
      <div style="max-width: 500px; margin: 0 auto; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
        <div style="background: linear-gradient(135deg, #1e3a5f, #2e6da4); padding: 30px; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 28px;">🏛️ CivicPulse</h1>
          <p style="color: #a8d4f5; margin: 8px 0 0;">Empowering Citizens, Building Communities</p>
        </div>
        <div style="padding: 40px 30px;">
          <h2 style="color: #1e3a5f; margin-top: 0;">${purposeText}</h2>
          <p style="color: #555; line-height: 1.6;">Your One-Time Password (OTP) for ${purposeText.toLowerCase()} is:</p>
          <div style="background: #f0f4f8; border: 2px dashed #2e6da4; border-radius: 12px; padding: 20px; text-align: center; margin: 20px 0;">
            <span style="font-size: 42px; font-weight: 800; letter-spacing: 10px; color: #1e3a5f; font-family: monospace;">${otp}</span>
          </div>
          <p style="color: #777; font-size: 14px;">⏱️ This OTP expires in <strong>10 minutes</strong>.</p>
          <p style="color: #777; font-size: 14px;">🔒 Do not share this OTP with anyone.</p>
          <div style="border-top: 1px solid #eee; margin-top: 30px; padding-top: 20px; text-align: center;">
            <p style="color: #aaa; font-size: 12px;">If you didn't request this, please ignore this email.</p>
            <p style="color: #aaa; font-size: 12px;">© 2024 CivicPulse. All rights reserved.</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  const data = await sendViaBrevo({
    to: email,
    subject: `Your CivicPulse verification code is ${otp}`,
    text: `Your CivicPulse ${purposeText} code is: ${otp}\n\nThis code expires in 10 minutes.\nDo not share this with anyone.`,
    html
  });

  console.log(`[Email] OTP sent to ${email} — MessageId: ${data.id}`);
  return data;
};

/**
 * Send issue report to authority
 */
const sendIssueToAuthority = async (issue, authorityEmail) => {
  const mediaLinksHtml = issue.media.map(m =>
    `<a href="${m.url}" style="display:inline-block; margin: 5px; padding: 8px 16px; background: #2e6da4; color: white; border-radius: 6px; text-decoration: none; font-size: 14px;">📎 View ${m.type === 'image' ? 'Photo' : 'Video'}</a>`
  ).join('');

  const severityColors = { low: '#27ae60', medium: '#f39c12', high: '#e67e22', critical: '#e74c3c' };
  const severityColor = severityColors[issue.severity] || '#888';

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>New Issue Report</title></head>
    <body style="font-family: 'Segoe UI', sans-serif; background: #f0f4f8; margin: 0; padding: 20px;">
      <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
        <div style="background: linear-gradient(135deg, #1e3a5f, #2e6da4); padding: 30px;">
          <h1 style="color: white; margin: 0;">🏛️ CivicPulse</h1>
          <h2 style="color: #a8d4f5; margin: 8px 0 0;">New Issue Report - Action Required</h2>
        </div>
        <div style="padding: 30px;">
          <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
            <strong>⚠️ Issue ID: ${issue.issueId}</strong>
          </div>
          <table style="width: 100%; border-collapse: collapse;">
            <tr style="background: #f8f9fa;">
              <td style="padding: 12px; border: 1px solid #dee2e6; font-weight: 600; width: 40%;">Category</td>
              <td style="padding: 12px; border: 1px solid #dee2e6;">${issue.category.replace(/_/g, ' ').toUpperCase()}</td>
            </tr>
            <tr>
              <td style="padding: 12px; border: 1px solid #dee2e6; font-weight: 600;">Title</td>
              <td style="padding: 12px; border: 1px solid #dee2e6;">${issue.title}</td>
            </tr>
            <tr style="background: #f8f9fa;">
              <td style="padding: 12px; border: 1px solid #dee2e6; font-weight: 600;">Severity</td>
              <td style="padding: 12px; border: 1px solid #dee2e6;"><span style="background: ${severityColor}; color: white; padding: 3px 10px; border-radius: 12px; font-size: 13px;">${issue.severity.toUpperCase()}</span></td>
            </tr>
            <tr>
              <td style="padding: 12px; border: 1px solid #dee2e6; font-weight: 600;">Description</td>
              <td style="padding: 12px; border: 1px solid #dee2e6;">${issue.description}</td>
            </tr>
            <tr style="background: #f8f9fa;">
              <td style="padding: 12px; border: 1px solid #dee2e6; font-weight: 600;">AI Analysis</td>
              <td style="padding: 12px; border: 1px solid #dee2e6;">${issue.aiDescription || 'N/A'}</td>
            </tr>
            <tr>
              <td style="padding: 12px; border: 1px solid #dee2e6; font-weight: 600;">Reported By</td>
              <td style="padding: 12px; border: 1px solid #dee2e6;">${issue.reporterName}</td>
            </tr>
            <tr style="background: #f8f9fa;">
              <td style="padding: 12px; border: 1px solid #dee2e6; font-weight: 600;">Date & Time</td>
              <td style="padding: 12px; border: 1px solid #dee2e6;">${new Date(issue.reportedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
            </tr>
            <tr>
              <td style="padding: 12px; border: 1px solid #dee2e6; font-weight: 600;">Location</td>
              <td style="padding: 12px; border: 1px solid #dee2e6;">${issue.location.address || 'See coordinates'}<br><small style="color: #888;">Lat: ${issue.location.coordinates[1]}, Lng: ${issue.location.coordinates[0]}</small></td>
            </tr>
          </table>

          <div style="margin-top: 20px;">
            <h3 style="color: #1e3a5f;">📸 Proof of Issue</h3>
            <div>${mediaLinksHtml || '<p style="color:#888">No media attached</p>'}</div>
          </div>

          <div style="margin-top: 25px; padding: 15px; background: #e8f4fd; border-radius: 8px; border-left: 4px solid #2e6da4;">
            <strong>📋 Instructions for Authority:</strong>
            <ul style="color: #555; margin: 10px 0;">
              <li>Reply to this email with updates on the issue status</li>
              <li>Include <code>[STATUS: IN_PROGRESS]</code> or <code>[STATUS: ACKNOWLEDGED]</code> in your reply to update status</li>
              <li>For resolution: include <code>[STATUS: RESOLVED]</code> and attach photo/video proof of resolution</li>
              <li>The system will automatically verify and close the issue</li>
            </ul>
          </div>

          <div style="text-align: center; margin-top: 25px;">
            <a href="${process.env.FRONTEND_URL}/track/${issue.issueId}"
               style="display:inline-block; padding: 12px 30px; background: #1e3a5f; color: white; border-radius: 8px; text-decoration: none; font-weight: 600;">
              🔍 View Issue on CivicPulse
            </a>
          </div>
        </div>
        <div style="background: #f8f9fa; padding: 15px; text-align: center;">
          <p style="color: #aaa; font-size: 12px; margin: 0;">© 2024 CivicPulse | Empowering Citizens, Building Communities</p>
        </div>
      </div>
    </body>
    </html>
  `;

  // NOTE: replyTo lets authority replies land in your IMAP inbox so the
  // imapService can parse [STATUS: ...] updates from their reply.
  const data = await sendViaBrevo({
    to: authorityEmail,
    replyTo: process.env.EMAIL_REPLY_TO || undefined,
    subject: `[CivicPulse] [${issue.issueId}] New Issue: ${issue.title} - ${issue.severity.toUpperCase()} Priority`,
    html
  });

  return data;
};

/**
 * Send status update email to reporter
 */
const sendStatusUpdateToReporter = async (reporterEmail, issue, update) => {
  const statusColors = {
    reported: '#6c757d', acknowledged: '#17a2b8', in_progress: '#ffc107',
    resolved: '#28a745', rejected: '#dc3545'
  };

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family: 'Segoe UI', sans-serif; background: #f0f4f8; margin: 0; padding: 20px;">
      <div style="max-width: 500px; margin: 0 auto; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
        <div style="background: linear-gradient(135deg, #1e3a5f, #2e6da4); padding: 30px; text-align: center;">
          <h1 style="color: white; margin: 0;">🏛️ CivicPulse</h1>
        </div>
        <div style="padding: 30px;">
          <h2 style="color: #1e3a5f;">Issue Update: ${issue.issueId}</h2>
          <p style="color: #555;">Your reported issue "<strong>${issue.title}</strong>" has been updated.</p>
          <div style="background: #f8f9fa; border-radius: 8px; padding: 15px; margin: 15px 0;">
            <strong>New Status:</strong>
            <span style="background: ${statusColors[issue.status] || '#888'}; color: white; padding: 3px 10px; border-radius: 12px; font-size: 13px; margin-left: 8px;">${issue.status.replace(/_/g, ' ').toUpperCase()}</span>
          </div>
          <div style="background: #f0f4f8; border-radius: 8px; padding: 15px;">
            <strong>Authority Message:</strong>
            <p style="color: #555; margin: 8px 0 0;">${update.message}</p>
          </div>
          ${issue.status === 'resolved' ? `
          <div style="background: #d4edda; border: 1px solid #c3e6cb; border-radius: 8px; padding: 15px; margin-top: 15px;">
            <strong>✅ Issue Resolved!</strong>
            <p style="color: #155724; margin: 5px 0 0;">Your issue has been resolved and verified by AI. Thank you for reporting!</p>
            ${update.aiVerificationNote ? `<p style="color: #555; font-size: 13px;">AI Verification: ${update.aiVerificationNote}</p>` : ''}
          </div>
          ` : ''}
          <div style="text-align: center; margin-top: 25px;">
            <a href="${process.env.FRONTEND_URL}/track/${issue.issueId}"
               style="display:inline-block; padding: 12px 30px; background: #1e3a5f; color: white; border-radius: 8px; text-decoration: none; font-weight: 600;">
              🔍 Track Your Issue
            </a>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  const data = await sendViaBrevo({
    to: reporterEmail,
    subject: `[CivicPulse] Issue ${issue.issueId} Update: ${issue.status.replace(/_/g, ' ').toUpperCase()}`,
    html
  });

  return data;
};

/**
 * Send badge/certificate email
 */
const sendBadgeEmail = async (userEmail, userName, badge, certificateBase64) => {
  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family: 'Segoe UI', sans-serif; background: #f0f4f8; margin: 0; padding: 20px;">
      <div style="max-width: 500px; margin: 0 auto; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
        <div style="background: linear-gradient(135deg, #f6d365, #fda085); padding: 30px; text-align: center;">
          <div style="font-size: 60px;">${badge.icon}</div>
          <h1 style="color: white; margin: 10px 0 0;">Badge Earned!</h1>
        </div>
        <div style="padding: 30px; text-align: center;">
          <h2 style="color: #1e3a5f;">Congratulations, ${userName}! 🎉</h2>
          <p style="color: #555;">You've earned the <strong>${badge.name}</strong> badge!</p>
          <p style="color: #777;">${badge.description}</p>
          <p style="color: #555;">Thank you for your active participation in making your community better!</p>
          <div style="margin-top: 25px;">
            <a href="${process.env.FRONTEND_URL}/profile"
               style="display:inline-block; padding: 12px 30px; background: #1e3a5f; color: white; border-radius: 8px; text-decoration: none; font-weight: 600;">
              View Your Profile
            </a>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  const attachments = [];
  if (certificateBase64) {
    attachments.push({
      filename: `CivicPulse_Certificate_${badge.name.replace(/\s/g, '_')}.pdf`,
      content: certificateBase64 // already base64 — Brevo expects raw base64, no data: prefix
    });
  }

  const data = await sendViaBrevo({
    to: userEmail,
    subject: `🏆 You earned the "${badge.name}" badge on CivicPulse!`,
    html,
    attachments
  });

  return data;
};

module.exports = {
  sendOTPEmail,
  sendIssueToAuthority,
  sendStatusUpdateToReporter,
  sendBadgeEmail
};

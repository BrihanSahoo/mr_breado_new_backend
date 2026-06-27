const nodemailer = require('nodemailer');
const { AppError } = require('../utils/errors');
const settings = require('./settingsService');

const clean = (value) => String(value ?? '').trim().replace(/^['"]|['"]$/g, '');

async function config() {
  const cfg = await settings.getSmtpConfig(false);
  return {
    ...cfg,
    port: Number(cfg.port || 587),
    secure: Boolean(cfg.secure || Number(cfg.port || 587) === 465),
    configured: Boolean(cfg.host && cfg.user && cfg.password && cfg.fromEmail),
  };
}

function safeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const templates = {
  PROMOTIONAL: { label:'Promotional', subject:'A special offer from Mr. Breado', heading:'A fresh offer is waiting for you', intro:'We have prepared a special offer for your next Mr. Breado order.', accent:'#f97316' },
  ALERT: { label:'Important alert', subject:'Important update from Mr. Breado', heading:'Important account update', intro:'Please review the following update related to your Mr. Breado account.', accent:'#dc2626' },
  PAYMENT_REQUEST: { label:'Payment request', subject:'Payment action required', heading:'Payment action required', intro:'Please review the payment request below and complete the required action.', accent:'#7c3aed' },
  DOCUMENT: { label:'Document', subject:'Documents from Mr. Breado', heading:'Documents shared with you', intro:'Mr. Breado has shared the following information and attachments with you.', accent:'#2563eb' },
  GENERAL: { label:'Admin message', subject:'Message from Mr. Breado', heading:'Message from Mr. Breado', intro:'You have received a message from the Mr. Breado administration team.', accent:'#ea580c' },
};

function normalizeCategory(value) {
  const key = clean(value).toUpperCase().replace(/[ -]+/g, '_');
  return templates[key] ? key : 'GENERAL';
}

function templateFor(category, recipientName = '') {
  const normalized = normalizeCategory(category);
  const source = templates[normalized];
  return {
    category: normalized,
    label: source.label,
    subject: source.subject,
    bodyText: `${recipientName ? `Hello ${recipientName},\n\n` : ''}${source.intro}\n\nAdd your message here.\n\nRegards,\nMr. Breado Team`,
  };
}

function htmlDocument({ category, recipientName, subject, bodyText }) {
  const normalized = normalizeCategory(category);
  const source = templates[normalized];
  const paragraphs = String(bodyText || '').split(/\n{2,}/).map((paragraph) => `<p style="margin:0 0 14px;line-height:1.65;color:#3f3f46">${safeHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#fff7ed;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:28px 14px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:auto;background:#ffffff;border-radius:24px;overflow:hidden;border:1px solid #fed7aa;box-shadow:0 18px 50px rgba(124,45,18,.12)"><tr><td style="padding:28px;background:linear-gradient(135deg,#431407,${source.accent});color:white"><div style="font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;opacity:.85">${safeHtml(source.label)}</div><h1 style="margin:10px 0 0;font-size:28px;line-height:1.15">${safeHtml(subject || source.heading)}</h1></td></tr><tr><td style="padding:28px"><p style="margin:0 0 16px;font-weight:700;color:#18181b">${recipientName ? `Hello ${safeHtml(recipientName)},` : 'Hello,'}</p>${paragraphs}<div style="margin-top:24px;padding-top:18px;border-top:1px solid #e4e4e7;color:#71717a;font-size:12px">This email was sent by the Mr. Breado administration team.</div></td></tr></table></td></tr></table></body></html>`;
}

function transporterFor(cfg) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port || 587),
    secure: Boolean(cfg.secure),
    auth: { user: cfg.user, pass: cfg.password },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
  });
}

async function verify() {
  const cfg = await config();
  if (!cfg.configured) throw new AppError('SMTP email delivery is not configured. Add SMTP details from Admin → API Keys.', 503, 'EMAIL_NOT_CONFIGURED');
  try {
    await transporterFor(cfg).verify();
    return { valid: true, provider: 'SMTP', host: cfg.host, port: cfg.port };
  } catch (error) {
    const code = String(error?.code || '').toUpperCase();
    if (['EAUTH', 'EENVELOPE'].includes(code)) throw new AppError('SMTP authentication failed. Check the email address, app password and sender.', 503, 'EMAIL_AUTH_FAILED');
    throw new AppError('SMTP server could not be reached. Check host, port, security and network access.', 503, 'EMAIL_CONNECTION_FAILED');
  }
}

async function send({ to, subject, html, text, attachments = [] }) {
  const cfg = await config();
  if (!cfg.configured || cfg.enabled === false) {
    throw new AppError('SMTP email delivery is not configured. Add SMTP host, username, password and sender email in the admin panel.', 503, 'EMAIL_NOT_CONFIGURED');
  }
  const fromName = clean(cfg.fromName || 'Mr. Breado').replace(/[<>\r\n]/g, '');
  const from = `${fromName} <${clean(cfg.fromEmail)}>`;
  try {
    const info = await transporterFor(cfg).sendMail({
      from,
      to: clean(to),
      replyTo: clean(cfg.replyTo || cfg.fromEmail),
      subject: clean(subject),
      html,
      text,
      attachments: attachments.map((file) => ({ filename: clean(file.originalname || file.filename || 'attachment'), content: file.buffer, contentType: clean(file.mimetype || 'application/octet-stream') })),
    });
    return { id: info.messageId || '', provider: 'SMTP', accepted: info.accepted || [] };
  } catch (error) {
    const code = String(error?.code || '').toUpperCase();
    if (code === 'EAUTH') throw new AppError('SMTP authentication failed. Use the correct email username and app password.', 503, 'EMAIL_AUTH_FAILED');
    if (code === 'EMESSAGE' || code === 'EENVELOPE') throw new AppError('The sender or recipient email address was rejected by the mail server.', 422, 'EMAIL_ADDRESS_REJECTED');
    throw new AppError('The email could not be sent right now. Please verify SMTP settings and try again.', 502, 'EMAIL_SEND_FAILED');
  }
}

module.exports = { config, normalizeCategory, templateFor, htmlDocument, verify, send };

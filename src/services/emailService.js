const axios = require('axios');
const { AppError } = require('../utils/errors');

const clean = (value) => String(value ?? '').trim().replace(/^['"]|['"]$/g, '');

function config() {
  const apiKey = clean(process.env.RESEND_API_KEY);
  const from = clean(
    process.env.ADMIN_EMAIL_FROM ||
    process.env.SYSTEM_EMAIL_FROM ||
    process.env.RESEND_FROM_EMAIL ||
    process.env.ADMIN_RESET_FROM_EMAIL,
  );
  const replyTo = clean(process.env.ADMIN_EMAIL_REPLY_TO || process.env.SYSTEM_EMAIL_REPLY_TO);
  return { apiKey, from, replyTo, configured: Boolean(apiKey && from) };
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
  PROMOTIONAL: {
    label: 'Promotional',
    subject: 'A special offer from Mr. Breado',
    heading: 'A fresh offer is waiting for you',
    intro: 'We have prepared a special offer for your next Mr. Breado order.',
    accent: '#f97316',
  },
  ALERT: {
    label: 'Important alert',
    subject: 'Important update from Mr. Breado',
    heading: 'Important account update',
    intro: 'Please review the following update related to your Mr. Breado account.',
    accent: '#dc2626',
  },
  PAYMENT_REQUEST: {
    label: 'Payment request',
    subject: 'Payment action required',
    heading: 'Payment action required',
    intro: 'Please review the payment request below and complete the required action.',
    accent: '#7c3aed',
  },
  DOCUMENT: {
    label: 'Document',
    subject: 'Documents from Mr. Breado',
    heading: 'Documents shared with you',
    intro: 'Mr. Breado has shared the following information and attachments with you.',
    accent: '#2563eb',
  },
  GENERAL: {
    label: 'Admin message',
    subject: 'Message from Mr. Breado',
    heading: 'Message from Mr. Breado',
    intro: 'You have received a message from the Mr. Breado administration team.',
    accent: '#ea580c',
  },
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
  const paragraphs = String(bodyText || '')
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 14px;line-height:1.65;color:#3f3f46">${safeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<!doctype html><html><body style="margin:0;background:#fff7ed;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:28px 14px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:auto;background:#ffffff;border-radius:24px;overflow:hidden;border:1px solid #fed7aa;box-shadow:0 18px 50px rgba(124,45,18,.12)"><tr><td style="padding:28px;background:linear-gradient(135deg,#431407,${source.accent});color:white"><div style="font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;opacity:.85">${safeHtml(source.label)}</div><h1 style="margin:10px 0 0;font-size:28px;line-height:1.15">${safeHtml(subject || source.heading)}</h1></td></tr><tr><td style="padding:28px"><p style="margin:0 0 16px;font-weight:700;color:#18181b">${recipientName ? `Hello ${safeHtml(recipientName)},` : 'Hello,'}</p>${paragraphs}<div style="margin-top:24px;padding-top:18px;border-top:1px solid #e4e4e7;color:#71717a;font-size:12px">This email was sent by the Mr. Breado administration team.</div></td></tr></table></td></tr></table></body></html>`;
}

async function send({ to, subject, html, text, attachments = [] }) {
  const cfg = config();
  if (!cfg.configured) {
    throw new AppError(
      'Email delivery is not configured. Add RESEND_API_KEY and ADMIN_EMAIL_FROM in the backend environment.',
      503,
      'EMAIL_NOT_CONFIGURED',
    );
  }
  const payload = {
    from: cfg.from,
    to: [clean(to)],
    subject: clean(subject),
    html,
    text,
    ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
    ...(attachments.length ? {
      attachments: attachments.map((file) => ({
        filename: clean(file.originalname || file.filename || 'attachment'),
        content: Buffer.from(file.buffer).toString('base64'),
        content_type: clean(file.mimetype || 'application/octet-stream'),
      })),
    } : {}),
  };
  try {
    const response = await axios.post('https://api.resend.com/emails', payload, {
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    });
    return { id: response.data?.id || '', provider: 'RESEND' };
  } catch (error) {
    const status = Number(error?.response?.status || 0);
    if (status === 401 || status === 403) {
      throw new AppError('Email API authentication failed. Verify the configured email API key and sender.', 503, 'EMAIL_AUTH_FAILED');
    }
    throw new AppError('The email could not be sent right now. Please try again.', 502, 'EMAIL_SEND_FAILED');
  }
}

module.exports = { config, normalizeCategory, templateFor, htmlDocument, send };

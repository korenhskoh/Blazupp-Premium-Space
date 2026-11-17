import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';

// ============================================================
// Email via Gmail / SMTP — now configurable from the app.
//
// Priority:
//   1. Credentials saved from the app (Settings → Delivery → Gmail)
//      live in <WA_AUTH_DIR or ./data>/smtp.json on the Railway volume.
//   2. If nothing is saved, fall back to the env vars:
//      GMAIL_USER, GMAIL_APP_PASSWORD, MAIL_FROM_NAME.
//
// The App Password is stored only on the service's volume and is
// never returned to the browser.
// ============================================================

const DATA_DIR  = process.env.WA_AUTH_DIR || path.join(process.cwd(), 'data');
const CRED_FILE = path.join(DATA_DIR, 'smtp.json');

let transporter = null;   // current nodemailer transport
let current     = null;   // { user, from, host, port, source }

function loadSaved() {
  try { return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')); } catch (e) { return null; }
}

// Work out the effective config (saved wins, else env).
function resolveConfig() {
  const saved = loadSaved();
  if (saved && saved.user && saved.pass) {
    return {
      user: saved.user,
      pass: saved.pass,
      from: saved.from || process.env.MAIL_FROM_NAME || 'Blazupp Labs',
      host: saved.host || 'smtp.gmail.com',
      port: Number(saved.port) || 465,
      source: 'app'
    };
  }
  const U = process.env.GMAIL_USER || '';
  const P = process.env.GMAIL_APP_PASSWORD || '';
  if (U && P) {
    return {
      user: U, pass: P,
      from: process.env.MAIL_FROM_NAME || 'Blazupp Labs',
      host: 'smtp.gmail.com', port: 465, source: 'env'
    };
  }
  return null;
}

// (Re)build the transporter from the effective config.
function build() {
  const c = resolveConfig();
  if (!c) { transporter = null; current = null; return; }
  transporter = nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.port === 465,
    auth: { user: c.user, pass: c.pass }
  });
  current = c;
}
build();   // on startup

function fromHeader() {
  if (!current) return 'Blazupp Labs';
  // allow "Name <addr>" in `from`, else wrap the display name around the user
  return /[<@]/.test(current.from) ? current.from : `"${current.from}" <${current.user}>`;
}

export function emailReady() {
  return current
    ? { configured: true, from: current.user, source: current.source }
    : { configured: false };
}

// Called by POST /set-smtp. Verifies the login, saves it, rebuilds.
// Pass pass:undefined to keep the existing stored password.
export async function setSmtp({ user, pass, from, host, port } = {}) {
  user = String(user || '').trim();
  if (!user) throw new Error('missing_user');
  const prev = loadSaved() || {};
  const finalPass = (pass != null && String(pass).trim())
    ? String(pass).trim().replace(/\s+/g, '')      // Gmail shows the app password with spaces
    : prev.pass;
  if (!finalPass) throw new Error('missing_pass');
  const finalHost = String(host || prev.host || 'smtp.gmail.com').trim();
  const finalPort = Number(port || prev.port || 465);
  const finalFrom = String(from || prev.from || '').trim();

  // verify before saving
  const test = nodemailer.createTransport({
    host: finalHost, port: finalPort, secure: finalPort === 465,
    auth: { user, pass: finalPass }
  });
  await test.verify();   // throws on bad credentials

  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(CRED_FILE,
    JSON.stringify({ user, pass: finalPass, from: finalFrom, host: finalHost, port: finalPort }, null, 2),
    { mode: 0o600 });
  build();   // apply immediately — no redeploy needed
  console.log('[email] credentials saved for', user);
  return { from: user };
}

export async function sendEmail({ to, subject, text, html, filename, pdfBase64 }) {
  if (!transporter) throw new Error('email_not_configured');
  const info = await transporter.sendMail({
    from: fromHeader(),
    to,
    subject: subject || 'Your invoice from Blazupp Labs',
    text: text || 'Please find your document attached.',
    html: html || undefined,
    attachments: [{
      filename: filename || 'document.pdf',
      content: Buffer.from(pdfBase64, 'base64'),
      contentType: 'application/pdf'
    }]
  });
  return info.messageId;
}

export async function sendEmailText({ to, subject, text, html }) {
  if (!transporter) throw new Error('email_not_configured');
  const info = await transporter.sendMail({
    from: fromHeader(),
    to,
    subject: subject || 'Reminder from Blazupp Labs',
    text: text || '',
    html: html || undefined
  });
  return info.messageId;
}

import express from 'express';
import { startWhatsApp, sendWhatsAppDocument, waStatus, waDisconnect, waReconnect } from './whatsapp.js';
import { sendEmail, emailReady, setSmtp } from './email.js';
import { startReminders, reminderStatus } from './reminders.js';

const app = express();

// PDFs are base64 — allow a generous body.
app.use(express.json({ limit: '25mb' }));

// ---- CORS: only your site may call this ----
const ALLOWED = (process.env.ALLOWED_ORIGINS ||
  'https://korenhskoh.github.io')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOWED.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Send-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- Shared secret: every send must carry the key ----
const SEND_KEY = process.env.SEND_KEY || '';
function requireKey(req, res, next) {
  if (!SEND_KEY) return res.status(500).json({ ok: false, error: 'server_missing_send_key' });
  if ((req.headers['x-send-key'] || '') !== SEND_KEY)
    return res.status(401).json({ ok: false, error: 'bad_key' });
  next();
}

// ---- health / status (no key needed, safe to expose) ----
app.get('/', (_req, res) => res.json({ ok: true, service: 'blazupp-sender' }));
app.get('/status', (_req, res) => {
  res.json({ ok: true, whatsapp: waStatus(), email: emailReady(), reminders: reminderStatus() });
});

// ---- Gmail / SMTP config from the app (key-protected) ----
// Body: { user, pass?, from?, host?, port? }  — omit pass to keep the saved one.
app.post('/set-smtp', requireKey, async (req, res) => {
  try {
    const r = await setSmtp(req.body || {});
    res.json({ ok: true, ...r });
  } catch (e) {
    const msg = String(e?.message || e);
    // verify() failures surface as EAUTH / Invalid login
    const bad = /EAUTH|Invalid login|535|credential|auth/i.test(msg);
    console.error('[set-smtp] failed:', msg);
    res.status(bad ? 400 : 500).json({ ok: false, error: bad ? 'auth_failed' : msg });
  }
});

// ---- WhatsApp connection controls (key-protected) ----
app.get('/wa/status', requireKey, (_req, res) => {
  res.json({ ok: true, whatsapp: waStatus() });
});
app.post('/wa/reconnect', requireKey, async (_req, res) => {
  try { await waReconnect(); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ ok: false, error: String(e?.message || e) }); }
});
app.post('/wa/disconnect', requireKey, async (_req, res) => {
  try { await waDisconnect(); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ ok: false, error: String(e?.message || e) }); }
});

// ---- WhatsApp QR pairing page (protect with the key via query) ----
app.get('/wa/qr', (req, res) => {
  if ((req.query.key || '') !== SEND_KEY) return res.status(401).send('bad key');
  const s = waStatus();
  if (s.connected) return res.send('<h2>WhatsApp is already connected ✓</h2>');
  if (!s.qrDataUrl) return res.send('<h2>Starting… refresh in a few seconds.</h2><script>setTimeout(()=>location.reload(),3000)</script>');
  res.send(`<!doctype html><meta charset=utf8><body style="font-family:sans-serif;text-align:center;padding:30px">
    <h2>Scan with WhatsApp → Linked devices</h2>
    <img src="${s.qrDataUrl}" style="width:300px;height:300px">
    <p>This page refreshes automatically.</p>
    <script>setTimeout(()=>location.reload(),20000)</script></body>`);
});

// ---- send an invoice/receipt over WhatsApp ----
app.post('/send/whatsapp', requireKey, async (req, res) => {
  try {
    const { phone, filename, pdfBase64, caption } = req.body || {};
    if (!phone || !pdfBase64) return res.status(400).json({ ok: false, error: 'phone_and_pdf_required' });
    const id = await sendWhatsAppDocument({ phone, filename: filename || 'document.pdf', pdfBase64, caption: caption || '' });
    res.json({ ok: true, id });
  } catch (e) {
    console.error('wa send failed:', e?.message || e);
    res.status(502).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---- send an invoice/receipt over email ----
app.post('/send/email', requireKey, async (req, res) => {
  try {
    const { to, subject, text, html, filename, pdfBase64 } = req.body || {};
    if (!to || !pdfBase64) return res.status(400).json({ ok: false, error: 'to_and_pdf_required' });
    const id = await sendEmail({ to, subject, text, html, filename: filename || 'document.pdf', pdfBase64 });
    res.json({ ok: true, id });
  } catch (e) {
    console.error('email send failed:', e?.message || e);
    res.status(502).json({ ok: false, error: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[blazupp-sender] listening on :${PORT}`);
  console.log(`[blazupp-sender] allowed origins: ${ALLOWED.join(', ')}`);
  startWhatsApp().catch(e => console.error('wa init:', e?.message || e));
  startReminders();
});

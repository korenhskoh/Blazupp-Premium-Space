import { sendWhatsAppText } from './whatsapp.js';
import { sendEmailText } from './email.js';

// The always-on reminder loop. It asks Supabase for bookings whose slot is
// within the configured lead time, sends a reminder to the admin (always) and
// the customer (only if that booking was ticked), then marks each one so it is
// never sent twice.
//
// Everything it needs comes from env vars:
//   SUPABASE_URL          e.g. https://amwtrrcshfjbxrlzipch.supabase.co
//   SUPABASE_ANON_KEY     the same anon key the web app uses
//   REMINDER_KEY          the shared secret that matches service_auth.reminder_key
//   REMINDER_LEAD_HOURS   how far ahead to remind (default 24)
//   REMINDER_ADMIN_PHONE  admin WhatsApp number (+60… or 60…)
//   REMINDER_ADMIN_EMAIL  admin email
//   REMINDER_EVERY_MIN    how often to check, in minutes (default 15)
//   REMINDER_ENABLED      'true' to turn the loop on

const SB_URL   = process.env.SUPABASE_URL || '';
const SB_KEY   = process.env.SUPABASE_ANON_KEY || '';
const RKEY     = process.env.REMINDER_KEY || '';
const LEAD     = Number(process.env.REMINDER_LEAD_HOURS || 24);
const EVERY    = Math.max(1, Number(process.env.REMINDER_EVERY_MIN || 15));
const ADMIN_PHONE = process.env.REMINDER_ADMIN_PHONE || '';
const ADMIN_EMAIL = process.env.REMINDER_ADMIN_EMAIL || '';
const COMPANY  = process.env.MAIL_FROM_NAME || 'Blazupp Labs';
const ENABLED  = String(process.env.REMINDER_ENABLED || '').toLowerCase() === 'true';
// Global switch: when true, EVERY booking reminds the customer automatically,
// regardless of the per-booking tick. When false, only ticked bookings do.
const REMIND_ALL = String(process.env.REMINDER_ALL_CUSTOMERS || '').toLowerCase() === 'true';

let timer = null;
let running = false;
let lastRun = null;
let lastResult = '';

function ready() {
  return !!(ENABLED && SB_URL && SB_KEY && RKEY);
}

export function reminderStatus() {
  return {
    enabled: ENABLED,
    configured: ready(),
    leadHours: LEAD,
    everyMin: EVERY,
    remindAllCustomers: REMIND_ALL,
    adminPhone: ADMIN_PHONE ? ('…' + ADMIN_PHONE.slice(-4)) : '',
    adminEmail: ADMIN_EMAIL || '',
    lastRun,
    lastResult
  };
}

async function rpc(fn, body) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`${fn} -> ${r.status} ${await r.text()}`);
  return r.json();
}

// Build the reminder text from a booking. Placeholders keep it readable.
function reminderText(b, forCustomer) {
  const when = `${b.slot_date} ${b.slot_time}`;
  const lines = [
    forCustomer
      ? `Hi ${b.name}, a friendly reminder of your upcoming booking with ${COMPANY}:`
      : `Reminder — upcoming booking:`,
    ``,
    `• ${b.type_name}`,
    `• ${when} (Malaysia time)`,
    b.location ? `• ${b.location}` : ``,
    `• ${b.pax} pax`,
    `• Ref: ${b.code}`,
  ];
  if (!forCustomer) {
    // the admin copy carries the customer's contact details
    lines.push(``, `Customer: ${b.name}`);
    if (b.phone) lines.push(`Phone: ${b.phone}`);
    if (b.email) lines.push(`Email: ${b.email}`);
    if (b.notes) lines.push(`Notes: ${b.notes}`);
  } else {
    lines.push(``, `See you then! Reply here if you need to make any changes.`);
  }
  return lines.filter(l => l !== ``).join('\n').replace(/\n{3,}/g, '\n\n');
}

async function sendToTargets(b) {
  const results = [];
  // recipient list: admin always; customer only if ticked
  const targets = [
    { who: 'admin', phone: ADMIN_PHONE, email: ADMIN_EMAIL, forCustomer: false }
  ];
  if (REMIND_ALL || b.remind_customer) {
    targets.push({ who: 'customer', phone: b.phone, email: b.email, forCustomer: true });
  }

  for (const t of targets) {
    const text = reminderText(b, t.forCustomer);
    // WhatsApp if the number is present and WA is linked
    if (t.phone) {
      try { await sendWhatsAppText({ phone: t.phone, text }); results.push(`${t.who}:wa`); }
      catch (e) { results.push(`${t.who}:wa-fail(${String(e.message || e).slice(0, 40)})`); }
    }
    // Email if the address is present and Gmail is configured
    if (t.email) {
      try {
        await sendEmailText({
          to: t.email,
          subject: `Booking reminder · ${b.type_name} · ${b.slot_date} ${b.slot_time}`,
          text
        });
        results.push(`${t.who}:email`);
      } catch (e) { results.push(`${t.who}:email-fail(${String(e.message || e).slice(0, 40)})`); }
    }
  }
  return results;
}

async function tick() {
  if (running || !ready()) return;
  running = true;
  try {
    const due = await rpc('reminders_due', { p_key: RKEY, p_lead_hours: LEAD });
    let sent = 0;
    for (const b of (due || [])) {
      const res = await sendToTargets(b);
      // only mark reminded if at least one message actually went out
      if (res.some(r => !r.includes('fail'))) {
        await rpc('mark_reminded', { p_key: RKEY, p_id: b.id });
        sent++;
      }
      await new Promise(r => setTimeout(r, 1200)); // pace sends
    }
    lastRun = new Date().toISOString();
    lastResult = `${(due || []).length} due, ${sent} reminded`;
    if ((due || []).length) console.log(`[reminders] ${lastResult}`);
  } catch (e) {
    lastRun = new Date().toISOString();
    lastResult = 'error: ' + String(e.message || e);
    console.error('[reminders]', lastResult);
  } finally {
    running = false;
  }
}

export function startReminders() {
  if (!ENABLED) { console.log('[reminders] disabled (set REMINDER_ENABLED=true)'); return; }
  if (!ready()) { console.log('[reminders] missing config — need SUPABASE_URL, SUPABASE_ANON_KEY, REMINDER_KEY'); return; }
  console.log(`[reminders] on · lead ${LEAD}h · every ${EVERY}min`);
  tick();                                   // run once at boot
  timer = setInterval(tick, EVERY * 60 * 1000);
}

export function stopReminders() { if (timer) { clearInterval(timer); timer = null; } }

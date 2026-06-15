'use strict';
/**
 * whatsapp.js — WhatsApp message delivery
 * Provider 1: CallMeBot (free, no account needed)
 * Provider 2: Twilio WhatsApp API (paid, reliable)
 */

const https = require('https');
const http  = require('http');

// ── Send via CallMeBot (free) ─────────────────────────────────────
async function sendCallMeBot({ phone, apikey, message }) {
  const encoded = encodeURIComponent(message);
  const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encoded}&apikey=${apikey}`;

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log(`[WhatsApp] ✅ CallMeBot sent to ${phone}`);
          resolve({ ok: true, provider: 'callmebot', response: data });
        } else {
          reject(new Error(`CallMeBot error ${res.statusCode}: ${data}`));
        }
      });
    }).on('error', reject);
  });
}

// ── Send via Twilio ───────────────────────────────────────────────
async function sendTwilio({ sid, token, from, to, message }) {
  const body = new URLSearchParams({
    From: from.startsWith('whatsapp:') ? from : `whatsapp:${from}`,
    To:   to.startsWith('whatsapp:')   ? to   : `whatsapp:${to}`,
    Body: message,
  });

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const options = {
    hostname: 'api.twilio.com',
    path:     `/2010-04-01/Accounts/${sid}/Messages.json`,
    method:   'POST',
    headers:  {
      'Authorization': `Basic ${auth}`,
      'Content-Type':  'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body.toString()),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        const parsed = JSON.parse(data);
        if (res.statusCode === 201) {
          console.log(`[WhatsApp] ✅ Twilio sent to ${to} — SID: ${parsed.sid}`);
          resolve({ ok: true, provider: 'twilio', sid: parsed.sid });
        } else {
          reject(new Error(`Twilio error: ${parsed.message || data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body.toString());
    req.end();
  });
}

// ── Unified sender ────────────────────────────────────────────────
async function sendWhatsApp({ config, phones, message }) {
  const provider = config.provider || 'callmebot';
  const results  = [];

  for (const phone of (Array.isArray(phones) ? phones : [phones])) {
    try {
      if (provider === 'twilio') {
        const r = await sendTwilio({
          sid:     config.twilio_sid,
          token:   config.twilio_token,
          from:    config.twilio_from,
          to:      phone,
          message,
        });
        results.push({ phone, ...r });
      } else {
        // Default: CallMeBot
        const r = await sendCallMeBot({
          phone:   phone.replace(/[^0-9+]/g,''),
          apikey:  config.callmebot_apikey,
          message,
        });
        results.push({ phone, ...r });
      }
    } catch (e) {
      console.error(`[WhatsApp] ❌ Failed to ${phone}:`, e.message);
      results.push({ phone, ok: false, error: e.message });
    }
  }
  return results;
}

// ── Format alert message ──────────────────────────────────────────
function formatAlertMessage(rule, value, liveData) {
  const sevEmoji = rule.severity==='critical'?'🔴':rule.severity==='info'?'🔵':'🟡';
  const condLabels = { lt:'dropped below', lte:'≤', gt:'exceeded', gte:'≥', eq:'=' };
  const cond = condLabels[rule.condition]||rule.condition;

  let msg = rule.message || `${sevEmoji} *OEE ALERT* — ${rule.name}\n\n📊 ${rule.signal}: *${value}* (${cond} ${rule.threshold})\n🕐 Shift: ${liveData?.SHIFT||'—'}\n⏰ Time: ${new Date().toLocaleTimeString('en-IN')}\n\n→ http://localhost:3000`;
  return msg
    .replace('{value}',     value)
    .replace('{signal}',    rule.signal)
    .replace('{threshold}', rule.threshold)
    .replace('{condition}', cond)
    .replace('{shift}',     liveData?.SHIFT||'—')
    .replace('{time}',      new Date().toLocaleString('en-IN'))
    .replace('{plant}',     liveData?.plant_name||'Plant');
}

// ── Format scheduled report message ──────────────────────────────
function formatReportMessage(schedule, period) {
  return `📅 *Scheduled Report Ready*\n\n📊 ${schedule.name}\n📋 Type: ${schedule.report_type}\n📅 Period: ${period}\n⏰ Generated: ${new Date().toLocaleString('en-IN')}\n\n→ Open Dashboard: http://localhost:3000`;
}

module.exports = { sendWhatsApp, formatAlertMessage, formatReportMessage };

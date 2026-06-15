'use strict';
/**
 * alert-engine.js
 * ─────────────────────────────────────────────────────────────
 * Runs as a background service inside the Express process.
 *
 * TWO responsibilities:
 * 1. THRESHOLD MONITOR — polls live data every 30s, checks alert rules
 * 2. SHIFT SCHEDULER   — detects shift boundaries and fires report emails
 *
 * Usage in server.js:
 *   const alertEngine = require('./lib/alert-engine');
 *   alertEngine.start({ db, loadAlertRules, loadAlertConfig, buildHTML, buildExcel, sendAlertEmail, sendReportEmail, sendWhatsApp, ... });
 */

const fs   = require('fs');
const path = require('path');

const HISTORY_PATH = path.join(__dirname, '..', 'config', 'alert_history.json');
const CHECK_INTERVAL_MS = 30000; // 30 seconds

let _opts = null;
let _lastTriggered = {}; // ruleId → timestamp
let _lastShift     = null;
let _engineTimer   = null;
let _shiftTimer    = null;

// ── Helpers ───────────────────────────────────────────────────────
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_PATH,'utf8')).history || []; } catch { return []; }
}
function saveHistory(history) {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify({ history: history.slice(0,500) }, null, 2));
}
function addHistory(entry) {
  const history = loadHistory();
  history.unshift({ ...entry, time: new Date().toISOString() });
  saveHistory(history);
}

// ── Evaluate a single rule condition ─────────────────────────────
function evaluate(rule, liveData) {
  const raw = liveData[rule.signal] ?? liveData[rule.signal?.toLowerCase()];
  const val = parseFloat(raw);
  if (isNaN(val)) return false;
  switch (rule.condition) {
    case 'lt':  return val <  rule.threshold;
    case 'lte': return val <= rule.threshold;
    case 'gt':  return val >  rule.threshold;
    case 'gte': return val >= rule.threshold;
    case 'eq':  return val === rule.threshold;
    default:    return false;
  }
}

// ── Check cooldown ────────────────────────────────────────────────
function isCooledDown(ruleId, cooldownMinutes) {
  const last = _lastTriggered[ruleId];
  if (!last) return true;
  const elapsed = (Date.now() - last) / 60000;
  return elapsed >= cooldownMinutes;
}

// ── Fire an alert ─────────────────────────────────────────────────
async function fireAlert(rule, value, liveData, config) {
  const delivery = rule.delivery || ['email'];
  const recipients = rule.emails || [];
  const phones     = rule.phones || [];
  const success = [];
  const errors  = [];

  // EMAIL
  if (delivery.includes('email') && recipients.length && config.smtp?.host && config.smtp?.user) {
    try {
      const { sendAlertEmail } = require('./mailer');
      await sendAlertEmail({ smtp: config.smtp, to: recipients, rule, value, liveData });
      success.push('email');
    } catch (e) {
      console.error('[AlertEngine] Email error:', e.message);
      errors.push('email: ' + e.message);
    }
  }

  // WHATSAPP
  if (delivery.includes('whatsapp') && phones.length && config.whatsapp?.callmebot_apikey) {
    try {
      const { sendWhatsApp, formatAlertMessage } = require('./whatsapp');
      const message = formatAlertMessage(rule, value, liveData);
      await sendWhatsApp({ config: config.whatsapp, phones, message });
      success.push('whatsapp');
    } catch (e) {
      console.error('[AlertEngine] WhatsApp error:', e.message);
      errors.push('whatsapp: ' + e.message);
    }
  }

  _lastTriggered[rule.id] = Date.now();

  addHistory({
    type: 'alert', rule_id: rule.id, rule_name: rule.name,
    message: `${rule.signal} = ${value} (threshold: ${rule.condition} ${rule.threshold})`,
    delivery, recipients: [...recipients, ...phones],
    success: errors.length === 0, errors,
  });

  console.log(`[AlertEngine] 🚨 Rule "${rule.name}" fired — value: ${value} | sent via: ${success.join(', ') || 'none'}`);
}

// ── THRESHOLD MONITOR ─────────────────────────────────────────────
async function runThresholdCheck() {
  try {
    const { rules, config } = _opts.loadAlertRules();
    if (!rules?.length) return;

    // Fetch live data
    let liveData = null;
    try {
      const fetch = require('node-fetch');
      const res = await fetch('http://localhost:1880/api/live', { timeout: 5000 });
      liveData = await res.json();
    } catch (e) {
      // Try cached data from Express
      liveData = _opts.getCachedData?.() || null;
    }
    if (!liveData) return;

    for (const rule of rules) {
      if (!rule.active) continue;
      if (!isCooledDown(rule.id, rule.cooldown || 60)) continue;

      const triggered = evaluate(rule, liveData);
      if (triggered) {
        const val = liveData[rule.signal] ?? liveData[rule.signal?.toLowerCase()];
        await fireAlert(rule, val, liveData, config);
      }
    }
  } catch (e) {
    console.error('[AlertEngine] Threshold check error:', e.message);
  }
}

// ── SHIFT BOUNDARY DETECTOR ───────────────────────────────────────
async function runShiftCheck() {
  try {
    const { schedules, config } = _opts.loadAlertRules();
    const shiftSchedules = (schedules || []).filter(s => s.active && s.trigger === 'shift_end');
    if (!shiftSchedules.length) return;

    let liveData = null;
    try {
      const fetch = require('node-fetch');
      const res = await fetch('http://localhost:1880/api/live', { timeout: 5000 });
      liveData = await res.json();
    } catch { liveData = _opts.getCachedData?.() || null; }
    if (!liveData) return;

    const currentShift = liveData.SHIFT;
    if (!currentShift) return;

    // Detect shift boundary
    if (_lastShift && _lastShift !== currentShift) {
      console.log(`[AlertEngine] 🕐 Shift boundary: ${_lastShift} → ${currentShift}`);

      for (const sched of shiftSchedules) {
        // Check if this shift is in scope
        const filter = sched.trigger_config?.shift || 'all';
        if (filter !== 'all' && filter !== _lastShift) continue;

        // Delay if configured
        const delaySec = (sched.trigger_config?.delay || 0) * 60 * 1000;
        setTimeout(() => runScheduledReport(sched, _lastShift, config), delaySec);
      }
    }

    _lastShift = currentShift;
  } catch (e) {
    console.error('[AlertEngine] Shift check error:', e.message);
  }
}

// ── SCHEDULED REPORT RUNNER ───────────────────────────────────────
async function runScheduledReport(schedule, shift, config) {
  try {
    console.log(`[AlertEngine] 📅 Running scheduled report: ${schedule.name}`);
    const { buildHTML, buildExcel } = require('./report-generator');

    // Determine time range
    const now = new Date();
    let from, to = now.toISOString();
    if (shift) {
      // Report covers the finished shift (last 8 hours)
      const shiftStart = new Date(now.getTime() - 8 * 60 * 60 * 1000);
      from = shiftStart.toISOString();
    } else if (schedule.trigger_config?.period === 'yesterday') {
      const yesterday = new Date(now); yesterday.setDate(yesterday.getDate()-1); yesterday.setHours(0,0,0,0);
      const endOfYesterday = new Date(now); endOfYesterday.setHours(0,0,0,0);
      from = yesterday.toISOString(); to = endOfYesterday.toISOString();
    } else {
      const hours = { last_1h:1, last_8h:8, last_24h:24, last_7d:168 }[schedule.trigger_config?.period] || 8;
      from = new Date(now.getTime() - hours*60*60*1000).toISOString();
    }

    // Query DB
    const db = _opts.db;
    const [hourly, summary, shiftRows] = await Promise.all([
      db.query(`SELECT time_bucket('1 hour',time) AS bucket, MODE() WITHIN GROUP (ORDER BY shift) AS shift,
        ROUND(AVG(plant_oee)::numeric,2) AS plant_oee, ROUND(AVG(plant_availability)::numeric,2) AS plant_availability,
        ROUND(AVG(plant_performance)::numeric,2) AS plant_performance, ROUND(AVG(plant_quality)::numeric,2) AS plant_quality,
        ROUND(AVG(em1_kwh)::numeric,2) AS em1_kwh, ROUND(AVG(em2_kwh)::numeric,2) AS em2_kwh,
        ROUND(AVG(em3_kwh)::numeric,2) AS em3_kwh, ROUND(AVG(em4_kwh)::numeric,2) AS em4_kwh, ROUND(AVG(em5_kwh)::numeric,2) AS em5_kwh,
        ROUND(AVG(w1_flow)::numeric,2) AS w1_flow, MAX(total_good) AS total_good, MAX(total_scrap) AS total_scrap
        FROM plant_readings WHERE time >= $1 AND time <= $2 GROUP BY bucket ORDER BY bucket ASC`, [from, to]),
      db.query(`SELECT ROUND(AVG(plant_oee)::numeric,2) AS avg_oee, ROUND(AVG(plant_availability)::numeric,2) AS avg_availability,
        ROUND(AVG(plant_performance)::numeric,2) AS avg_performance, ROUND(AVG(plant_quality)::numeric,2) AS avg_quality,
        MAX(total_good) AS total_good, MAX(total_scrap) AS total_scrap, MAX(total_stops) AS total_stops,
        ROUND(SUM(em1_kwh+em2_kwh+em3_kwh+em4_kwh+em5_kwh)::numeric,1) AS total_kwh, COUNT(*) AS readings
        FROM plant_readings WHERE time >= $1 AND time <= $2`, [from, to]),
      db.query(`SELECT shift, COUNT(*) AS readings, ROUND(AVG(plant_oee)::numeric,2) AS avg_oee,
        ROUND(AVG(plant_availability)::numeric,2) AS avg_availability, ROUND(AVG(plant_performance)::numeric,2) AS avg_performance,
        ROUND(AVG(plant_quality)::numeric,2) AS avg_quality, MAX(total_good) AS total_good, MAX(total_scrap) AS total_scrap,
        MAX(total_stops) AS total_stops, ROUND(SUM(em1_kwh+em2_kwh+em3_kwh+em4_kwh+em5_kwh)::numeric,1) AS total_kwh
        FROM plant_readings WHERE time >= $1 AND time <= $2 AND shift IS NOT NULL GROUP BY shift ORDER BY shift`, [from, to]),
    ]);

    const payload = {
      rows: hourly.rows, shiftRows: shiftRows.rows,
      summary: summary.rows[0]||{},
      meta: { type: schedule.report_type||'oee', from, to, plant_name: schedule.plant_id||'All Plants' },
      config: { title: schedule.name },
    };

    const reportHTML   = buildHTML(payload);
    const reportBuffer = schedule.format==='excel'||schedule.format==='both' ? await buildExcel(payload) : null;

    // Send email
    if (config.smtp?.host && schedule.emails?.length) {
      const { sendReportEmail } = require('./mailer');
      await sendReportEmail({
        smtp: config.smtp, to: schedule.emails, cc: schedule.cc||[],
        subject: schedule.subject, schedule,
        reportHTML, reportBuffer, format: schedule.format,
      });
    }

    // Send WhatsApp notification
    if (config.whatsapp?.callmebot_apikey && schedule.phones?.length) {
      const { sendWhatsApp, formatReportMessage } = require('./whatsapp');
      const period = `${from.slice(0,10)} → ${to.slice(0,10)}`;
      await sendWhatsApp({ config: config.whatsapp, phones: schedule.phones, message: formatReportMessage(schedule, period) });
    }

    addHistory({
      type: 'schedule', schedule_id: schedule.id, schedule_name: schedule.name,
      message: `Scheduled report sent for period ${from.slice(0,10)} → ${to.slice(0,10)}`,
      delivery: ['email', config.whatsapp?.callmebot_apikey&&schedule.phones?.length?'whatsapp':null].filter(Boolean),
      recipients: schedule.emails, success: true,
    });

    console.log(`[AlertEngine] ✅ Report "${schedule.name}" sent to ${schedule.emails?.join(', ')}`);
  } catch (e) {
    console.error(`[AlertEngine] ❌ Scheduled report error:`, e.message);
    addHistory({
      type: 'schedule', schedule_name: schedule.name,
      message: 'Report generation failed: ' + e.message,
      success: false,
    });
  }
}

// ── DAILY / WEEKLY SCHEDULER ──────────────────────────────────────
async function checkTimedSchedules() {
  try {
    const { schedules, config } = _opts.loadAlertRules();
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const weekDay = now.getDay();

    for (const sched of (schedules||[])) {
      if (!sched.active) continue;
      const tc = sched.trigger_config || {};

      if (sched.trigger === 'daily' && tc.time === hhmm) {
        await runScheduledReport(sched, null, config);
      } else if (sched.trigger === 'weekly' && String(tc.day) === String(weekDay) && tc.time === hhmm) {
        await runScheduledReport(sched, null, config);
      }
    }
  } catch (e) { console.error('[AlertEngine] Timed schedule error:', e.message); }
}

// ── START ENGINE ──────────────────────────────────────────────────
function start(opts) {
  _opts = opts;
  console.log('[AlertEngine] 🚀 Starting — threshold check every 30s, shift monitor every 60s');

  // Threshold monitor
  _engineTimer = setInterval(runThresholdCheck, CHECK_INTERVAL_MS);

  // Shift boundary + timed schedules — check every 60s
  _shiftTimer = setInterval(async () => {
    await runShiftCheck();
    await checkTimedSchedules();
  }, 60000);

  // Initial check
  setTimeout(runThresholdCheck, 5000);
}

function stop() {
  if (_engineTimer) clearInterval(_engineTimer);
  if (_shiftTimer)  clearInterval(_shiftTimer);
  console.log('[AlertEngine] ⏹ Stopped');
}

module.exports = { start, stop, runScheduledReport, loadHistory, saveHistory, addHistory };

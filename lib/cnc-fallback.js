'use strict';
/**
 * cnc-fallback.js — Facto-Bot Smart NLP Agent v3
 * ─────────────────────────────────────────────────────────────────
 * Full natural-language understanding without any AI API key:
 *   • Date parsing  : "30 may 2026", "today", "yesterday", "30/05/26"
 *   • Shift parsing : "shift a/b", "morning/night shift"
 *   • 12 intent types with dynamic SQL generation
 *   • Rich formatted responses with IST timestamps
 */

const { normalizeHinglish } = require('./free-ai-agent');

// ─────────────────────────────────────────────────────────────────
// DATE / TIME UTILITIES
// ─────────────────────────────────────────────────────────────────
const MONTHS = {
  jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
  jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
  january:1, february:2, march:3, april:4, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12,
};

function nowIST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

function padDate(y, m, d) {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function nextDayStr(dateStr) {
  // Compute next calendar date reliably
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * parseDate(text) → { date: 'YYYY-MM-DD', label: string, isDefault: bool }
 * Handles: "30 may 2026", "may 30 2026", "30/05/2026", "today", "yesterday"
 */
function parseDate(text) {
  const t = text.toLowerCase();
  const now = nowIST();

  // today / aaj
  if (/\btoday\b|\baaj\b/.test(t)) {
    const d = padDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
    return { date: d, label: 'today (' + d + ')', isToday: true };
  }
  // yesterday / kal
  if (/\byesterday\b|\bkal\b/.test(t)) {
    const y = new Date(now); y.setDate(y.getDate() - 1);
    const d = padDate(y.getFullYear(), y.getMonth() + 1, y.getDate());
    return { date: d, label: 'yesterday (' + d + ')' };
  }

  // "30 may 2026"  or  "30 may 26"  or  "30 may"
  const dmy = t.match(/(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s*(?:,?\s*(\d{2,4}))?/);
  if (dmy) {
    const day = parseInt(dmy[1]);
    const mon = MONTHS[dmy[2]];
    let year  = dmy[3] ? parseInt(dmy[3]) : now.getFullYear();
    if (year < 100) year += 2000;
    return { date: padDate(year, mon, day), label: dmy[0].trim() };
  }

  // "may 30 2026"
  const mdy = t.match(/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})\s*,?\s*(\d{2,4})/);
  if (mdy) {
    const mon = MONTHS[mdy[1]];
    const day = parseInt(mdy[2]);
    let year  = parseInt(mdy[3]); if (year < 100) year += 2000;
    return { date: padDate(year, mon, day), label: mdy[0].trim() };
  }

  // "30/05/2026" or "30-05-2026" (day/month/year)
  const dslash = t.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
  if (dslash) {
    const day = parseInt(dslash[1]);
    const mon = parseInt(dslash[2]);
    let year  = parseInt(dslash[3]); if (year < 100) year += 2000;
    return { date: padDate(year, mon, day), label: dslash[0] };
  }

  // ISO "2026-05-30"
  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return { date: iso[0], label: iso[0] };

  // Default: today
  const d = padDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
  return { date: d, label: 'today', isDefault: true };
}

/**
 * parseShift(text) → 'A' | 'B' | null
 */
function parseShift(text) {
  const t = text.toLowerCase();
  if (/shift\s*[_\-]?a\b|shift\s*1\b|morning\s*shift|\bday\s*shift\b/.test(t))   return 'A';
  if (/shift\s*[_\-]?b\b|shift\s*2\b|night\s*shift|evening\s*shift/.test(t))      return 'B';
  return null;  // both shifts
}

/**
 * Build time-range SQL for cnc_data given date string and shift.
 * Returns SQL fragment (uses AT TIME ZONE for index-friendly UTC comparison).
 * tableAlias: 'cd' or '' (no alias)
 */
function shiftTimeSQL(dateStr, shift, tableAlias) {
  const col  = tableAlias ? `${tableAlias}.time` : 'time';
  const next = nextDayStr(dateStr);
  if (shift === 'A') {
    return `${col} >= '${dateStr} 07:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata'
        AND ${col} <  '${dateStr} 19:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata'`;
  }
  if (shift === 'B') {
    return `${col} >= '${dateStr} 19:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata'
        AND ${col} <  '${next} 07:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata'`;
  }
  // Both shifts: full production day  07:00 → next 07:00
  return `${col} >= '${dateStr} 07:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata'
      AND ${col} <  '${next} 07:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata'`;
}

// ─────────────────────────────────────────────────────────────────
// INTENT CLASSIFIER  (12 intents)
// ─────────────────────────────────────────────────────────────────
function classifyIntent(rawQuestion) {
  const t = normalizeHinglish(rawQuestion).toLowerCase();

  // ── Program numbers / which program ran ─────────────────────────
  if (/\bprogram\b|\bprogramme\b|\bpgm\b|\bprog(?:ram)?\s*(?:no|num|number|#)?\b/.test(t)) {
    return { intent: 'program' };
  }

  // ── Live / current status ────────────────────────────────────────
  if (/\bnow\b|\bright now\b|\blive\b|\bcurrent(?:ly)?\b|\breal.?time\b/.test(t) &&
      !/oee|parts|alarm/.test(t)) {
    return { intent: 'live' };
  }

  // ── OEE trend ───────────────────────────────────────────────────
  if (/trend|last\s*\d+\s*day|past\s*\d+\s*day|this\s*week|weekly/.test(t) && /oee/.test(t)) {
    const dm = t.match(/last\s*(\d+)\s*day/);
    return { intent: 'oee_trend', days: dm ? parseInt(dm[1]) : 7 };
  }

  // ── OEE ─────────────────────────────────────────────────────────
  if (/\boee\b/.test(t)) return { intent: 'oee' };

  // ── Root Cause Analysis / Why ────────────────────────────────────
  if (/root cause|rca|why.*machine|why.*down|why.*stop|why.*alarm|why is|machine.*why/.test(t)) {
    return { intent: 'rca' };
  }

  // ── Alarms / Errors ─────────────────────────────────────────────
  if (/alarm|error|fault|emergency/.test(t)) return { intent: 'alarm' };

  // ── Cycle time ──────────────────────────────────────────────────
  if (/cycle\s*time|cycle\s*sec|avg.*cycle|cycle.*avg|cycle\s*per/.test(t)) {
    return { intent: 'cycle' };
  }

  // ── Downtime ────────────────────────────────────────────────────
  if (/downtime|down\s*time|how.*long.*stop|stop.*time|idle\s*time/.test(t)) {
    return { intent: 'downtime' };
  }

  // ── Quality / Rejection ─────────────────────────────────────────
  if (/reject|scrap|defect|quality.*part|bad.*part/.test(t)) return { intent: 'rejection' };

  // ── Production / Parts ──────────────────────────────────────────
  if (/parts?\b|produc|output|how many|count/.test(t)) {
    const hm = t.match(/last\s*(\d+)\s*hour/);
    if (hm) return { intent: 'parts_hours', hours: parseInt(hm[1]) };
    return { intent: 'parts' };
  }

  // ── Machine status (live) ────────────────────────────────────────
  if (/status|running|spindle|feed|speed|machine/.test(t)) return { intent: 'live' };

  // ── General shift summary ────────────────────────────────────────
  if (/shift|summary|overview|report/.test(t)) return { intent: 'shift_summary' };

  return { intent: 'unknown' };
}

// ─────────────────────────────────────────────────────────────────
// SQL BUILDERS
// ─────────────────────────────────────────────────────────────────
function buildSQL(intentObj, dateObj, shift) {
  const dateStr     = dateObj.date;
  const shiftClause = shift ? `AND shift = '${shift}'` : '';

  switch (intentObj.intent) {

    // ── PROGRAM — which programs ran in a shift ──────────────────
    case 'program': {
      const tw = shiftTimeSQL(dateStr, shift, 'cd');
      return {
        sql: `
          SELECT
            cd.program_no,
            pm.part_name,
            COUNT(*)                                                          AS reading_count,
            COUNT(CASE WHEN cd.last_cycle_time_sec > 2 THEN 1 END)          AS cycle_count,
            ROUND(AVG(CASE WHEN cd.last_cycle_time_sec > 2
                           THEN cd.last_cycle_time_sec END)::numeric, 1)    AS avg_cycle_sec,
            ROUND(MIN(CASE WHEN cd.last_cycle_time_sec > 2
                           THEN cd.last_cycle_time_sec END)::numeric, 1)    AS best_cycle_sec,
            COALESCE(pm.target_cycle_sec, 0)                                 AS target_cycle_sec,
            to_char(MIN(cd.time AT TIME ZONE 'Asia/Kolkata'), 'HH24:MI')    AS first_seen,
            to_char(MAX(cd.time AT TIME ZONE 'Asia/Kolkata'), 'HH24:MI')    AS last_seen
          FROM cnc_data cd
          LEFT JOIN program_master pm
            ON pm.program_no = cd.program_no AND pm.machine_id = 'MACHINE001'
          WHERE cd.machine_id = 'MACHINE001'
            AND ${tw}
            AND cd.program_no IS NOT NULL
          GROUP BY cd.program_no, pm.part_name, pm.target_cycle_sec
          ORDER BY reading_count DESC`,
        params: [], type: 'program',
        label: dateObj.label + (shift ? ' · Shift ' + shift : ''),
      };
    }

    // ── OEE — from oee_results (pre-calculated per shift) ────────
    case 'oee':
    case 'shift_summary': {
      return {
        sql: `
          SELECT
            shift_date::text, shift,
            ROUND(oee::numeric, 1)          AS oee,
            ROUND(availability::numeric, 1) AS availability,
            ROUND(performance::numeric, 1)  AS performance,
            ROUND(quality::numeric, 1)      AS quality,
            parts_produced, target_parts, good_parts, rejection_count,
            ROUND(parts_attainment::numeric, 1) AS attainment_pct,
            running_min, downtime_min, alarm_count,
            ROUND(COALESCE(avg_cycle_sec, 0)::numeric, 1)    AS avg_cycle,
            ROUND(COALESCE(target_cycle_sec, 0)::numeric, 1) AS target_cycle
          FROM oee_results
          WHERE machine_id = 'MACHINE001'
            AND shift_date = '${dateStr}'
            ${shiftClause}
          ORDER BY shift`,
        params: [], type: 'oee',
        label: dateObj.label + (shift ? ' · Shift ' + shift : ''),
      };
    }

    // ── OEE TREND — multi-day OEE from oee_results ───────────────
    case 'oee_trend': {
      const days = intentObj.days || 7;
      return {
        sql: `
          SELECT
            shift_date::text AS date, shift,
            ROUND(oee::numeric, 1)          AS oee,
            ROUND(availability::numeric, 1) AS availability,
            ROUND(performance::numeric, 1)  AS performance,
            ROUND(quality::numeric, 1)      AS quality,
            parts_produced, target_parts
          FROM oee_results
          WHERE machine_id = 'MACHINE001'
            AND shift_date >= CURRENT_DATE - INTERVAL '${days} days'
          ORDER BY shift_date DESC, shift`,
        params: [], type: 'oee_trend',
        label: `last ${days} days`,
      };
    }

    // ── PARTS — from oee_results ─────────────────────────────────
    case 'parts': {
      return {
        sql: `
          SELECT
            shift, parts_produced, target_parts, good_parts, rejection_count,
            ROUND(parts_attainment::numeric, 1) AS attainment_pct,
            ROUND(oee::numeric, 1)              AS oee
          FROM oee_results
          WHERE machine_id = 'MACHINE001'
            AND shift_date = '${dateStr}'
            ${shiftClause}
          ORDER BY shift`,
        params: [], type: 'parts',
        label: dateObj.label + (shift ? ' · Shift ' + shift : ''),
      };
    }

    // ── PARTS (last N hours) — from cnc_data ─────────────────────
    case 'parts_hours': {
      const hrs = intentObj.hours || 8;
      return {
        sql: `
          SELECT
            to_char(MIN(time AT TIME ZONE 'Asia/Kolkata'), 'DD-Mon HH24:MI') AS from_time,
            to_char(MAX(time AT TIME ZONE 'Asia/Kolkata'), 'DD-Mon HH24:MI') AS to_time,
            MIN(part_count)                    AS counter_start,
            MAX(part_count)                    AS counter_end,
            MAX(part_count) - MIN(part_count)  AS parts_made,
            COUNT(*)                           AS readings
          FROM cnc_data
          WHERE machine_id = 'MACHINE001'
            AND time >= NOW() - INTERVAL '${hrs} hours'`,
        params: [], type: 'parts_hours', hours: hrs,
        label: `last ${hrs} hours`,
      };
    }

    // ── LIVE — latest machine reading ────────────────────────────
    case 'live': {
      return {
        sql: `
          SELECT
            to_char(time AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') AS time_ist,
            machine_state, is_running, spindle_speed, feed_rate,
            raw_cycle_time_sec, last_cycle_time_sec,
            part_count, alarm_active, alarm_no, program_no
          FROM cnc_data
          WHERE machine_id = 'MACHINE001'
          ORDER BY time DESC
          LIMIT 1`,
        params: [], type: 'live',
        label: 'right now',
      };
    }

    // ── ALARM — alarm events in a shift ─────────────────────────
    case 'alarm': {
      const tw = shiftTimeSQL(dateStr, shift, '');
      return {
        sql: `
          SELECT
            alarm_no,
            COUNT(*) AS occurrences,
            to_char(MIN(time AT TIME ZONE 'Asia/Kolkata'), 'HH24:MI:SS') AS first_at,
            to_char(MAX(time AT TIME ZONE 'Asia/Kolkata'), 'HH24:MI:SS') AS last_at,
            ROUND(EXTRACT(EPOCH FROM (MAX(time) - MIN(time))) / 60.0) AS span_min
          FROM cnc_data
          WHERE machine_id = 'MACHINE001'
            AND alarm_active = true
            AND ${tw}
          GROUP BY alarm_no
          ORDER BY occurrences DESC`,
        params: [], type: 'alarm',
        label: dateObj.label + (shift ? ' · Shift ' + shift : ''),
      };
    }

    // ── CYCLE TIME — from cnc_data with program_master join ──────
    case 'cycle': {
      const tw = shiftTimeSQL(dateStr, shift, 'cd');
      return {
        sql: `
          SELECT
            cd.program_no,
            pm.part_name,
            ROUND(AVG(cd.last_cycle_time_sec)::numeric, 1)  AS avg_cycle,
            ROUND(MIN(cd.last_cycle_time_sec)::numeric, 1)  AS best_cycle,
            ROUND(MAX(cd.last_cycle_time_sec)::numeric, 1)  AS worst_cycle,
            ROUND(COALESCE(pm.target_cycle_sec, 0)::numeric, 1) AS target_cycle,
            COUNT(*) AS cycle_count
          FROM cnc_data cd
          LEFT JOIN LATERAL (
            SELECT target_cycle_sec, part_name
            FROM program_master
            WHERE machine_id = 'MACHINE001' AND program_no = cd.program_no
            LIMIT 1
          ) pm ON true
          WHERE cd.machine_id = 'MACHINE001'
            AND cd.last_cycle_time_sec > 2
            AND cd.last_cycle_time_sec < 600
            AND ${tw}
          GROUP BY cd.program_no, pm.part_name, pm.target_cycle_sec
          ORDER BY cycle_count DESC`,
        params: [], type: 'cycle',
        label: dateObj.label + (shift ? ' · Shift ' + shift : ''),
      };
    }

    // ── DOWNTIME — from oee_results ──────────────────────────────
    case 'downtime': {
      return {
        sql: `
          SELECT
            shift,
            running_min, downtime_min, major_downtime_min, minor_downtime_min,
            ROUND(availability::numeric, 1) AS availability_pct,
            alarm_count,
            ROUND(idle_sec / 60.0::numeric, 1) AS idle_min
          FROM oee_results
          WHERE machine_id = 'MACHINE001'
            AND shift_date = '${dateStr}'
            ${shiftClause}
          ORDER BY shift`,
        params: [], type: 'downtime',
        label: dateObj.label + (shift ? ' · Shift ' + shift : ''),
      };
    }

    // ── REJECTION / QUALITY ──────────────────────────────────────
    case 'rejection': {
      return {
        sql: `
          SELECT
            shift, rejection_count, parts_produced, good_parts,
            ROUND(scrap_rate::numeric, 2)  AS rejection_pct,
            ROUND(quality::numeric, 1)     AS quality_pct
          FROM oee_results
          WHERE machine_id = 'MACHINE001'
            AND shift_date = '${dateStr}'
            ${shiftClause}
          ORDER BY shift`,
        params: [], type: 'rejection',
        label: dateObj.label + (shift ? ' · Shift ' + shift : ''),
      };
    }

    // ── RCA — quick root cause ────────────────────────────────────
    case 'rca': {
      return {
        sql: `
          SELECT
            o.shift,
            ROUND(o.oee::numeric, 1)          AS oee,
            ROUND(o.availability::numeric, 1) AS availability,
            ROUND(o.performance::numeric, 1)  AS performance,
            ROUND(o.quality::numeric, 1)      AS quality,
            o.downtime_min, o.alarm_count,
            o.parts_produced, o.target_parts,
            (SELECT alarm_no FROM cnc_data
              WHERE machine_id='MACHINE001' AND alarm_active=true
              ORDER BY time DESC LIMIT 1) AS latest_alarm,
            (SELECT machine_state FROM cnc_data
              WHERE machine_id='MACHINE001' ORDER BY time DESC LIMIT 1) AS current_state
          FROM oee_results o
          WHERE o.machine_id = 'MACHINE001'
            AND o.shift_date = '${dateStr}'
            ${shiftClause}
          ORDER BY o.shift`,
        params: [], type: 'rca',
        label: dateObj.label + (shift ? ' · Shift ' + shift : ''),
      };
    }

    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// ANSWER FORMATTERS
// ─────────────────────────────────────────────────────────────────
function fmt1(v) { return (v != null && v !== '') ? parseFloat(v).toFixed(1) : '—'; }
function fmtInt(v) { return (v != null && v !== '') ? parseInt(v).toLocaleString() : '—'; }
function pct(v) { return (v != null && v !== '') ? parseFloat(v).toFixed(1) + '%' : '—'; }

function noDataMsg(label) {
  return `📭 **No data found for ${label}**\n\n` +
    `Possible reasons:\n` +
    `• No recordings exist for this date/shift combination\n` +
    `• Node-RED may not have been running during this period\n` +
    `• OEE results may not have been calculated yet\n\n` +
    `💡 Try: "What is today's OEE?" or "Machine status right now"`;
}

function formatAnswer(intentType, rows, label, extras) {
  if (!rows || rows.length === 0) return noDataMsg(label);

  switch (intentType) {

    // ── PROGRAM ────────────────────────────────────────────────
    case 'program': {
      const validRows = rows.filter(r => r.program_no != null);
      if (!validRows.length) return `📭 **No program data recorded for ${label}**`;

      let text = `🔧 **Programs Run — ${label}**\n\n`;
      validRows.forEach((r, i) => {
        const progLabel = `O${String(r.program_no).padStart(4, '0')}`;
        const partName  = r.part_name ? ` — ${r.part_name}` : '';
        const icon      = i === 0 ? '🏭' : '  ';
        const effStr = (parseFloat(r.target_cycle_sec) > 0 && parseFloat(r.avg_cycle_sec) > 0)
          ? ` | Eff: ${(parseFloat(r.target_cycle_sec) / parseFloat(r.avg_cycle_sec) * 100).toFixed(0)}%` : '';
        text += `${icon} **${progLabel}**${partName}\n`;
        text += `   ├ Readings: ${fmtInt(r.reading_count)} | Cycles: ${fmtInt(r.cycle_count)}\n`;
        if (parseFloat(r.avg_cycle_sec) > 0) {
          const targetStr = parseFloat(r.target_cycle_sec) > 0
            ? ` / Target: ${r.target_cycle_sec}s${effStr}` : '';
          text += `   ├ Avg Cycle: **${r.avg_cycle_sec}s**${targetStr}\n`;
          if (r.best_cycle_sec) text += `   ├ Best Cycle: ${r.best_cycle_sec}s\n`;
        }
        text += `   └ Active: ${r.first_seen || '?'} → ${r.last_seen || '?'} IST\n\n`;
      });
      if (validRows.length > 1) {
        text += `_${validRows.length} programs ran during this period_`;
      }
      return text.trim();
    }

    // ── OEE / SHIFT SUMMARY ────────────────────────────────────
    case 'oee':
    case 'shift_summary': {
      let text = `📊 **OEE Summary — ${label}**\n\n`;
      for (const r of rows) {
        const o = parseFloat(r.oee) || 0;
        const grade = o >= 80 ? '🟢 World Class' : o >= 65 ? '🟡 Typical' : '🔴 Needs Attention';
        text += `${o >= 80 ? '🟢' : o >= 65 ? '🟡' : '🔴'} **Shift ${r.shift}: ${r.oee}% OEE** (${grade})\n`;
        text += `   ├ Avail: **${r.availability}%**  Perf: **${r.performance}%**  Qual: **${r.quality}%**\n`;
        text += `   ├ Parts: ${r.parts_produced} / ${r.target_parts}`;
        if (r.attainment_pct) text += ` (${r.attainment_pct}% attainment)`;
        if (r.good_parts)     text += ` | Good: ${r.good_parts} | Rej: ${r.rejection_count || 0}`;
        text += '\n';
        text += `   ├ Running: ${r.running_min} min | Downtime: ${r.downtime_min} min | Alarms: ${r.alarm_count}\n`;
        if (r.avg_cycle && parseFloat(r.avg_cycle) > 0) {
          const tcStr = parseFloat(r.target_cycle) > 0 ? ` / Target: ${r.target_cycle}s` : '';
          text += `   └ Avg Cycle: ${r.avg_cycle}s${tcStr}\n`;
        }
        text += '\n';
      }
      if (rows.length > 1) {
        const total = rows.reduce((s, r) => s + (parseInt(r.parts_produced) || 0), 0);
        text += `🏭 Total parts (all shifts): **${total}**`;
      }
      return text.trim();
    }

    // ── OEE TREND ──────────────────────────────────────────────
    case 'oee_trend': {
      let text = `📈 **OEE Trend — ${label}**\n\n`;
      for (const r of rows) {
        const o    = parseFloat(r.oee) || 0;
        const icon = o >= 80 ? '🟢' : o >= 65 ? '🟡' : '🔴';
        text += `${icon} ${r.date} Sh.${r.shift}: **${r.oee}%** `;
        text += `(A:${r.availability}% P:${r.performance}%) — ${r.parts_produced} pcs\n`;
      }
      const avg = rows.reduce((s, r) => s + (parseFloat(r.oee) || 0), 0) / rows.length;
      text += `\n📊 Average OEE: **${avg.toFixed(1)}%** over ${rows.length} shift(s)`;
      return text;
    }

    // ── PARTS (date/shift) ──────────────────────────────────────
    case 'parts': {
      let text = `🏭 **Production — ${label}**\n\n`;
      let total = 0;
      for (const r of rows) {
        const a = parseFloat(r.attainment_pct) || 0;
        const icon = a >= 100 ? '✅' : a >= 70 ? '🟡' : '🔴';
        text += `${icon} Shift ${r.shift}: **${r.parts_produced} / ${r.target_parts}** pcs`;
        if (r.attainment_pct) text += ` (${r.attainment_pct}% attainment)`;
        if (r.oee)            text += ` | OEE: ${r.oee}%`;
        if (r.good_parts)     text += `\n   Good: ${r.good_parts} | Rejected: ${r.rejection_count || 0}`;
        text += '\n';
        total += parseInt(r.parts_produced) || 0;
      }
      if (rows.length > 1) text += `\n🏭 Total today: **${total} parts**`;
      return text;
    }

    // ── PARTS (last N hours) ────────────────────────────────────
    case 'parts_hours': {
      const r    = rows[0];
      const hrs  = extras?.hours || 8;
      const made = parseInt(r.parts_made) || 0;
      const rate = made > 0 ? (made / hrs).toFixed(1) : '—';
      return `🏭 **Production — last ${hrs} hours**\n\n` +
        `📦 **${made} parts** produced\n` +
        `⚡ Rate: **${rate} pcs/hr**\n\n` +
        `⏰ Window: ${r.from_time || '?'} → ${r.to_time || '?'} IST\n` +
        `📡 ${r.readings} readings collected`;
    }

    // ── LIVE STATUS ─────────────────────────────────────────────
    case 'live': {
      const r    = rows[0];
      const st   = (r.machine_state || '').toUpperCase();
      const icon = st === 'RUNNING' ? '🟢' : (st === 'ALARM' || st === 'EMERGENCY') ? '🔴' : '⚪';
      return `🔧 **Machine Status — Right Now**\n\n` +
        `${icon} State: **${r.machine_state || 'UNKNOWN'}** | Running: ${r.is_running ? 'Yes ✅' : 'No ⛔'}\n` +
        `⚡ Spindle: **${r.spindle_speed || 0} RPM** | Feed: **${r.feed_rate || 0} mm/min**\n` +
        `⏱ Cycle (live): ${r.raw_cycle_time_sec || 0}s | Last completed: ${r.last_cycle_time_sec || 0}s\n` +
        `🏭 Part count: **${r.part_count || 0}** | Program: **O${String(r.program_no || 0).padStart(4, '0')}**\n` +
        `🚨 Alarm: ${r.alarm_active ? `**YES — Code ${r.alarm_no}** 🔴` : 'None ✅'}\n` +
        `🕐 Time: ${r.time_ist || '—'} IST`;
    }

    // ── ALARM ───────────────────────────────────────────────────
    case 'alarm': {
      if (!rows[0]?.alarm_no) {
        return `✅ **No alarms recorded — ${label}**\n\nMachine ran cleanly during this period.`;
      }
      let text = `🚨 **Alarms — ${label}**\n\n`;
      for (const r of rows) {
        text += `⚠️ Alarm **#${r.alarm_no}** — ${r.occurrences}× occurrence(s)\n`;
        text += `   First: ${r.first_at} | Last: ${r.last_at} IST`;
        if (r.span_min > 0) text += ` | Duration: ~${r.span_min} min`;
        text += '\n\n';
      }
      return text.trim();
    }

    // ── CYCLE TIME ──────────────────────────────────────────────
    case 'cycle': {
      let text = `⏱ **Cycle Time Analysis — ${label}**\n\n`;
      for (const r of rows) {
        const progLabel  = r.program_no ? `O${String(r.program_no).padStart(4, '0')}` : 'Unknown';
        const partName   = r.part_name ? ` — ${r.part_name}` : '';
        const target     = parseFloat(r.target_cycle) || 0;
        const avg        = parseFloat(r.avg_cycle) || 0;
        const effStr     = (target > 0 && avg > 0) ? ` | Eff: **${(target / avg * 100).toFixed(0)}%**` : '';
        const icon       = (target > 0 && avg <= target) ? '✅' : avg <= target * 1.2 ? '🟡' : '🔴';
        text += `${icon} **${progLabel}**${partName}\n`;
        text += `   Avg: **${r.avg_cycle}s** | Best: ${r.best_cycle}s | Worst: ${r.worst_cycle}s`;
        if (target > 0) text += ` | Target: ${r.target_cycle}s${effStr}`;
        text += `\n   Cycles analysed: ${r.cycle_count}\n\n`;
      }
      return text.trim();
    }

    // ── DOWNTIME ────────────────────────────────────────────────
    case 'downtime': {
      let text = `⛔ **Downtime Analysis — ${label}**\n\n`;
      for (const r of rows) {
        const a = parseFloat(r.availability_pct) || 0;
        text += `${a >= 90 ? '✅' : a >= 75 ? '🟡' : '🔴'} Shift ${r.shift}:\n`;
        text += `   ├ Total downtime: **${r.downtime_min} min**\n`;
        text += `     └ Major (machine stopped): ${r.major_downtime_min || '—'} min\n`;
        text += `     └ Minor (spindle idle):    ${r.minor_downtime_min || '—'} min\n`;
        text += `   ├ Running: ${r.running_min} min | Idle: ${r.idle_min || '—'} min\n`;
        text += `   └ Availability: **${r.availability_pct}%** | Alarms: ${r.alarm_count}\n\n`;
      }
      return text.trim();
    }

    // ── REJECTION ───────────────────────────────────────────────
    case 'rejection': {
      let text = `❌ **Quality / Rejection — ${label}**\n\n`;
      for (const r of rows) {
        const spct = parseFloat(r.rejection_pct) || 0;
        const icon = spct <= 2 ? '🟢' : spct <= 5 ? '🟡' : '🔴';
        text += `${icon} Shift ${r.shift}: **${r.rejection_count || 0} rejected** of ${r.parts_produced} total\n`;
        text += `   Rejection rate: **${r.rejection_pct}%** | Good: ${r.good_parts} | Quality: ${r.quality_pct}%\n\n`;
      }
      return text.trim();
    }

    // ── RCA ─────────────────────────────────────────────────────
    case 'rca': {
      const r = rows[0] || {};
      const o = parseFloat(r.oee) || 0;
      const a = parseFloat(r.availability) || 0;
      const p = parseFloat(r.performance) || 0;
      const q = parseFloat(r.quality) || 0;
      const losses = [
        { name: 'Availability', loss: 100 - a },
        { name: 'Performance',  loss: 100 - p },
        { name: 'Quality',      loss: 100 - q },
      ].sort((x, y) => y.loss - x.loss);

      let text = `🔍 **Quick RCA — ${label}**\n\n`;
      text += `📊 OEE: **${r.oee}%** | Avail: **${r.availability}%** | Perf: **${r.performance}%** | Qual: **${r.quality}%**\n`;
      text += `📦 Parts: ${r.parts_produced}/${r.target_parts} | Downtime: ${r.downtime_min} min | Alarms: ${r.alarm_count}\n\n`;

      if (r.current_state && r.current_state !== 'RUNNING') {
        text += `🔴 **Machine currently: ${r.current_state}**`;
        if (r.latest_alarm) text += ` — Alarm code: ${r.latest_alarm}`;
        text += '\n\n';
      }

      text += `🎯 **Biggest loss driver: ${losses[0].name} (${losses[0].loss.toFixed(1)}% lost)**\n\n`;

      if (a < 85) {
        text += `🔧 **Availability Actions:**\n`;
        text += `1. Clear ${r.alarm_count} alarm(s) — check alarm log\n`;
        text += `2. Log each downtime event in Downtime Log page\n`;
        text += `3. Verify operator is continuously loading parts\n\n`;
      }
      if (p < 75) {
        text += `⚡ **Performance Actions:**\n`;
        text += `1. Compare actual vs target cycle time in program_master\n`;
        text += `2. Check Industrial CNC program feed/speed override values\n`;
        text += `3. Look for micro-stops (spindle idle > 30s)\n\n`;
      }
      if (q < 95) {
        text += `✅ **Quality Actions:**\n`;
        text += `1. Review rejection log for defect types\n`;
        text += `2. Check tooling condition and setup parameters\n\n`;
      }
      return text.trim();
    }

    // ── UNKNOWN ─────────────────────────────────────────────────
    default:
      return `📭 I didn't understand that question.\n\n` +
        `Try (English or Hinglish):\n` +
        `• "What programs ran on 30 May 2026 Shift B?"\n` +
        `• "What is today's OEE?" / "Aaj ka OEE kya hai?"\n` +
        `• "Parts produced last 4 hours" / "Aaj kitne parts bane?"\n` +
        `• "Machine status right now" / "Machine ka status kya hai?"\n` +
        `• "Show alarms today Shift A"\n` +
        `• "Cycle time analysis Shift B today"\n` +
        `• "Downtime today" / "Downtime kitna raha?"\n` +
        `• "OEE trend last 7 days"\n` +
        `• "Why is OEE low today?" / "Machine band kyun hai?"`;
  }
}

// ─────────────────────────────────────────────────────────────────
// MAIN ENTRY
// ─────────────────────────────────────────────────────────────────
async function cncAnswer(question, db) {
  try {
    const intentObj = classifyIntent(question);
    const dateObj   = parseDate(question);
    const shift     = parseShift(question);

    const query = buildSQL(intentObj, dateObj, shift);

    if (!query) {
      return {
        ok:     true,
        text:   formatAnswer('unknown', [], ''),
        engine: 'cnc-fallback',
        model:  'nlp-machine-001-v3',
      };
    }

    const result = await db.query(query.sql, query.params);
    const text   = formatAnswer(query.type, result.rows, query.label, intentObj);

    return {
      ok:     true,
      text,
      sql:    query.sql,
      rows:   result.rows.length,
      engine: 'cnc-fallback',
      model:  'nlp-machine-001-v3',
      intent: intentObj.intent,
      date:   dateObj.date,
      shift:  shift || 'both',
    };

  } catch (e) {
    console.error('[CNC-Fallback v3] Error:', e.message);
    return {
      ok:   false,
      text: `⚠️ Query failed: ${e.message}\n\n` +
            `Try: "What is today's OEE?" or "Machine status right now"`,
      engine: 'cnc-fallback',
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// SUGGESTION CHIPS  (shown in chat UI)
// ─────────────────────────────────────────────────────────────────
const CNC_SUGGESTIONS = [
  "What programs ran on 30 May 2026 Shift B?",
  "What is today's OEE?",
  "Parts produced last 4 hours",
  "Machine status right now",
  "Aaj ka OEE kya hai?",
  "Parts kitne bane aaj?",
  "Show alarms today",
  "Cycle time analysis Shift A today",
  "Downtime analysis today",
  "OEE trend last 7 days",
  "Quality rejection today",
  "Machine band kyun hai?",
];

module.exports = { cncAnswer, CNC_SUGGESTIONS };

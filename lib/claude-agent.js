'use strict';
/**
 * claude-agent.js — Facto-Bot AI Engine
 * ────────────────────────────────────────────────────────────────
 * Supports two AI backends (auto-detected from .env):
 *
 *   GEMINI_API_KEY=AIza...   → Google Gemini 2.0 Flash (FREE tier)
 *   ANTHROPIC_API_KEY=sk-ant → Claude Sonnet + Haiku (paid, best quality)
 *
 * Priority: Gemini → Claude → Rule-based fallback
 *
 * Both convert natural-language questions into TimescaleDB SQL
 * for machine_live and oee_results tables.
 *
 * Install:
 *   npm install @google/generative-ai   (Gemini)
 *   npm install @anthropic-ai/sdk        (Claude - optional)
 */

// ── SDK imports (soft — no crash if not installed) ────────────────
let GoogleGenerativeAI;
try { ({ GoogleGenerativeAI } = require('@google/generative-ai')); }
catch(e) { GoogleGenerativeAI = null; }

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); }
catch(e) { Anthropic = null; }

// ── Shared DB schema for SQL generation ──────────────────────────
const DB_SCHEMA = `
You are generating SQL for a PostgreSQL/TimescaleDB production monitoring system.
Machine: Industrial CNC Controller  |  Machine ID: MACHINE-001
Company: Demo Manufacturing, Factory Site
Target cycle time: 45 seconds  |  Target parts per shift: 900
Net available time per shift: 40,500 seconds (675 minutes)
Shifts: Shift A = 07:00–19:00 IST  |  Shift B = 19:00–07:00 IST
Timezone: All timestamps stored UTC, display in IST (UTC+5:30)

=== TABLE 1: machine_live (TimescaleDB hypertable — live, ~5 sec rows) ===
  ts                    TIMESTAMPTZ   — reading timestamp (UTC)
  machine_id            TEXT          — always 'MACHINE-001'
  machine_state         TEXT          — 'RUNNING','IDLE','ALARM','SETUP','MAINTENANCE','POWER OFF'
  is_running            BOOLEAN       — true if actively producing
  part_count            INTEGER       — cumulative parts (resets each shift)
  last_cycle_time_sec   NUMERIC       — last completed part cycle time (sec)
  raw_cycle_time_sec    NUMERIC       — live timer counting up (sec)
  spindle_speed         NUMERIC       — RPM
  feed_rate             NUMERIC       — mm/min
  alarm_active          BOOLEAN       — true if alarm is active
  alarm_no              INTEGER       — alarm code (0 = no alarm)
  program_no            INTEGER       — running program number

=== TABLE 2: oee_results (pre-calculated per shift, refreshed every 5 min) ===
  machine_id            TEXT
  shift_date            DATE          — IST date
  shift                 CHAR(1)       — 'A' or 'B'
  oee                   NUMERIC       — OEE % (0–100)
  availability          NUMERIC       — Availability %
  performance           NUMERIC       — Performance %
  quality               NUMERIC       — Quality %
  parts_produced        INTEGER       — parts made this shift
  target_parts          INTEGER       — 900
  good_parts            INTEGER
  rejection_count       INTEGER
  scrap_rate            NUMERIC       — % rejected
  parts_attainment      NUMERIC       — actual/target × 100
  running_sec           NUMERIC       — seconds running
  downtime_sec          NUMERIC       — seconds down
  net_available_sec     NUMERIC       — 40500
  major_downtime_sec    NUMERIC       — machine STOP or ALARM
  minor_downtime_sec    NUMERIC       — RUNNING but spindle=0, feed=0
  running_min, downtime_min, major_downtime_min, minor_downtime_min  NUMERIC
  avg_cycle_sec         NUMERIC       — average cycle time
  best_cycle_sec        NUMERIC       — fastest cycle time
  worst_cycle_sec       NUMERIC       — slowest cycle time
  cycle_efficiency      NUMERIC       — target_cycle/avg_cycle × 100
  target_cycle_sec      NUMERIC       — 45
  alarm_count           INTEGER
  rows_count            INTEGER
  calculated_at         TIMESTAMPTZ

=== SQL RULES ===
1. "today" → shift_date = CURRENT_DATE  (oee_results) or
              ts AT TIME ZONE 'Asia/Kolkata' >= CURRENT_DATE (machine_live)
2. "this shift" → filter by shift='A' or 'B' based on current IST hour
3. "last N hours" → ts >= NOW() - INTERVAL 'N hours'  (ALWAYS use time-based WHERE, NEVER LIMIT)
4. Parts produced in range: MAX(part_count) - MIN(part_count)  (NEVER SUM part_count)
5. Downtime: time where machine_state != 'RUNNING' or is_running=false
6. Use ROUND(value::numeric, 2) for decimals
7. For trends/history: prefer oee_results (faster)
8. For live/current data: use machine_live
9. ONLY return SELECT queries — never INSERT, UPDATE, DELETE, DROP, ALTER, CREATE
10. CRITICAL — NEVER use LIMIT (except for "machine status right now" / "latest reading").
    All production/parts queries MUST use time-based WHERE filters only.
    Using LIMIT on part_count gives wrong results because machine_live has ~17,000 rows/day.
11. part_count is CUMULATIVE (resets each shift). To get parts produced in any window:
    use MAX(part_count) - MIN(part_count) over the time window. NEVER use SUM(part_count).

=== EXAMPLES ===

Q: What is today's OEE?
SELECT shift, oee, availability, performance, quality,
       parts_produced, target_parts, ROUND(parts_attainment::numeric,1) AS attainment_pct,
       running_min, downtime_min, avg_cycle_sec, alarm_count
FROM oee_results
WHERE machine_id='MACHINE-001' AND shift_date=CURRENT_DATE ORDER BY shift;

Q: Parts produced this shift?
SELECT MAX(part_count)-MIN(part_count) AS parts_made,
       MAX(part_count) AS counter_now, COUNT(*) AS readings,
       MAX(ts) AT TIME ZONE 'Asia/Kolkata' AS last_update
FROM machine_live
WHERE machine_id='MACHINE-001'
  AND (ts AT TIME ZONE 'Asia/Kolkata')::date = CURRENT_DATE
  AND EXTRACT(HOUR FROM ts AT TIME ZONE 'Asia/Kolkata') >= 7
  AND EXTRACT(HOUR FROM ts AT TIME ZONE 'Asia/Kolkata') < 19;

Q: Parts produced last 2 hours?
SELECT MIN(ts AT TIME ZONE 'Asia/Kolkata') AS from_time,
       MAX(ts AT TIME ZONE 'Asia/Kolkata') AS to_time,
       MIN(part_count) AS counter_start,
       MAX(part_count) AS counter_end,
       MAX(part_count) - MIN(part_count) AS parts_made,
       COUNT(*) AS readings
FROM machine_live
WHERE machine_id='MACHINE-001'
  AND ts >= NOW() - INTERVAL '2 hours';

Q: Parts produced last 4 hours?
SELECT MIN(ts AT TIME ZONE 'Asia/Kolkata') AS from_time,
       MAX(ts AT TIME ZONE 'Asia/Kolkata') AS to_time,
       MIN(part_count) AS counter_start,
       MAX(part_count) AS counter_end,
       MAX(part_count) - MIN(part_count) AS parts_made,
       COUNT(*) AS readings
FROM machine_live
WHERE machine_id='MACHINE-001'
  AND ts >= NOW() - INTERVAL '4 hours';

Q: Hourly production breakdown last 8 hours?
SELECT time_bucket('1 hour', ts) AT TIME ZONE 'Asia/Kolkata' AS hour_ist,
       MAX(part_count) - MIN(part_count) AS parts_made,
       COUNT(*) AS readings
FROM machine_live
WHERE machine_id='MACHINE-001'
  AND ts >= NOW() - INTERVAL '8 hours'
GROUP BY time_bucket('1 hour', ts)
ORDER BY hour_ist;

Q: OEE trend last 7 days?
SELECT shift_date, shift, ROUND(oee::numeric,1) AS oee,
       ROUND(availability::numeric,1) AS availability,
       ROUND(performance::numeric,1) AS performance,
       parts_produced, target_parts
FROM oee_results
WHERE machine_id='MACHINE-001' AND shift_date >= CURRENT_DATE - INTERVAL '7 days'
ORDER BY shift_date, shift;

Q: What alarms happened today?
SELECT alarm_no, COUNT(*) AS occurrences,
       MIN(ts AT TIME ZONE 'Asia/Kolkata') AS first_at,
       MAX(ts AT TIME ZONE 'Asia/Kolkata') AS last_at
FROM machine_live
WHERE machine_id='MACHINE-001' AND alarm_active=true
  AND (ts AT TIME ZONE 'Asia/Kolkata')::date = CURRENT_DATE
GROUP BY alarm_no ORDER BY occurrences DESC;

Q: Machine status right now?
SELECT ts AT TIME ZONE 'Asia/Kolkata' AS time_ist,
       machine_state, is_running, spindle_speed, feed_rate,
       raw_cycle_time_sec, last_cycle_time_sec,
       part_count, alarm_active, alarm_no, program_no
FROM machine_live WHERE machine_id='MACHINE-001' ORDER BY ts DESC LIMIT 1;
`;

const SYSTEM_SQL = `You are Facto-Bot, an AI assistant for Demo CNC Machine machine monitoring at Demo Manufacturing.

${DB_SCHEMA}

CRITICAL: Respond with ONLY a valid SQL SELECT query in a \`\`\`sql code block.
No explanation. No extra text. Only SQL.`;

const SYSTEM_FORMAT = `You are Facto-Bot, a smart CNC machine intelligence assistant for Factory Operator at Demo Manufacturing.

You convert raw database results into clear factory-floor insights.

RULES:
- Lead with the key answer immediately (number first)
- Use **bold** for important numbers
- Emojis: 📊 OEE  ✅ Good  ❌ Problem  ⚠️ Warning  ⏱ Time  🏭 Parts  🔧 Machine  🚨 Alarm  ⚡ Performance  🎯 Target  📈 Trend
- OEE: 🟢 ≥80% World Class  🟡 65–79% Typical  🔴 <65% Needs Attention
- Keep it concise — no filler words
- Always mention the time period
- If no data: say to check Node-RED pipeline
- End with one actionable insight when useful`;

// ── SQL extractor ─────────────────────────────────────────────────
function extractSQL(text) {
  const m = text.match(/```sql\s*([\s\S]*?)```/i);
  if (m) return m[1].trim();
  const s = text.match(/SELECT[\s\S]+?(?:;|$)/i);
  if (s) return s[0].trim();
  return null;
}

// ── Safety validator ──────────────────────────────────────────────
function validateSQL(sql) {
  if (!sql) throw new Error('No SQL generated');
  const up = sql.toUpperCase();
  for (const kw of ['INSERT','UPDATE','DELETE','DROP','TRUNCATE','ALTER','CREATE','GRANT','REVOKE']) {
    if (new RegExp(`\\b${kw}\\b`).test(up)) throw new Error(`Blocked: ${kw} not allowed`);
  }
  if (!up.trim().startsWith('SELECT')) throw new Error('Only SELECT allowed');
  return sql;
}

// ── Production query sanitizer ────────────────────────────────────
// Fixes AI-generated subqueries like:
//   SELECT MAX(part_count)-MIN(part_count) FROM (SELECT ... LIMIT 100) t
// which only cover ~8 minutes of data instead of the requested time range.
// Strips LIMIT N (N > 1) from subqueries when query involves part_count.
function sanitizeProductionSQL(sql) {
  // Only fix queries involving part_count (production counting)
  if (!/part_count/i.test(sql)) return sql;

  // Pattern: subquery with ORDER BY ts DESC LIMIT N (N>1)
  // Remove the LIMIT clause inside subqueries — keeps the time-based WHERE filter intact
  const fixed = sql.replace(
    /(\(\s*SELECT\s[\s\S]*?)\s+ORDER\s+BY\s+ts\s+DESC\s+LIMIT\s+(?:[2-9]\d*|\d{2,})\s*(\))/gi,
    (match, before, after) => {
      console.warn('[Facto-Bot] ⚠️  Removed unsafe LIMIT from production subquery — using full time window instead');
      return before + after;
    }
  );

  // Also remove top-level ORDER BY ts DESC LIMIT N (N>1) from production queries
  // (keeps the time filter, just removes the row cap)
  return fixed.replace(
    /ORDER\s+BY\s+ts\s+DESC\s+LIMIT\s+(?:[2-9]\d*|\d{2,})\s*$/i,
    (match) => {
      console.warn('[Facto-Bot] ⚠️  Removed top-level LIMIT from production query — using full time window instead');
      return '';
    }
  );
}

// ══════════════════════════════════════════════════════════════════
// GEMINI ENGINE (FREE — gemini-2.0-flash)
// ══════════════════════════════════════════════════════════════════
async function geminiAnswer(question, db, apiKey) {
  if (!GoogleGenerativeAI) throw new Error('@google/generative-ai not installed');
  const genAI = new GoogleGenerativeAI(apiKey);

  // Turn 1: Generate SQL
  const sqlModel = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    generationConfig: { maxOutputTokens: 1024, temperature: 0.1 }
  });
  const sqlPrompt = `${SYSTEM_SQL}\n\nQuestion: ${question}`;
  const sqlResult = await sqlModel.generateContent(sqlPrompt);
  const sqlText   = sqlResult.response.text();
  const rawSQL    = extractSQL(sqlText);

  let sql, dbResults = [], dbError;
  try {
    sql = validateSQL(sanitizeProductionSQL(rawSQL));
    const r = await db.query(sql);
    dbResults = r.rows;
  } catch(e) {
    dbError = e.message;
  }

  // Turn 2: Format answer
  const fmtModel = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    generationConfig: { maxOutputTokens: 800, temperature: 0.3 }
  });
  const ctx = dbError
    ? `${SYSTEM_FORMAT}\n\nQuestion: "${question}"\nSQL: ${sql||rawSQL||'none'}\nError: ${dbError}\n\nTell the user clearly what went wrong.`
    : `${SYSTEM_FORMAT}\n\nQuestion: "${question}"\nSQL: ${sql}\nResults (${dbResults.length} rows):\n${JSON.stringify(dbResults, null, 2)}\n\nFormat a clear answer.`;

  const fmtResult = await fmtModel.generateContent(ctx);
  const answer    = fmtResult.response.text();

  return {
    ok:     true,
    text:   answer,
    sql:    sql || null,
    rows:   dbResults.length,
    raw:    dbResults,
    engine: 'gemini',
    model:  'gemini-2.0-flash (FREE)',
  };
}

// ══════════════════════════════════════════════════════════════════
// CLAUDE ENGINE (claude-sonnet-4-6 + claude-haiku-4-5)
// ══════════════════════════════════════════════════════════════════
async function claudeAnswer(question, db, apiKey) {
  if (!Anthropic) throw new Error('@anthropic-ai/sdk not installed');
  const client = new Anthropic({ apiKey });

  // Turn 1: SQL
  const sqlResp = await client.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 1024,
    system: SYSTEM_SQL,
    messages: [{ role: 'user', content: question }],
  });
  const rawSQL = extractSQL(sqlResp.content[0]?.text || '');

  let sql, dbResults = [], dbError;
  try {
    sql = validateSQL(sanitizeProductionSQL(rawSQL));
    const r = await db.query(sql);
    dbResults = r.rows;
  } catch(e) { dbError = e.message; }

  // Turn 2: Format
  const ctx = dbError
    ? `Question: "${question}"\nSQL: ${sql||rawSQL||'none'}\nError: ${dbError}`
    : `Question: "${question}"\nSQL: ${sql}\nResults (${dbResults.length} rows):\n${JSON.stringify(dbResults, null, 2)}`;

  const fmtResp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 800,
    system: SYSTEM_FORMAT,
    messages: [{ role: 'user', content: ctx }],
  });

  return {
    ok:     true,
    text:   fmtResp.content[0]?.text || 'No answer',
    sql:    sql || null,
    rows:   dbResults.length,
    raw:    dbResults,
    engine: 'claude',
    model:  'claude-sonnet-4-6 + haiku-4-5',
  };
}

// ══════════════════════════════════════════════════════════════════
// UNIFIED ENTRY — auto-picks best available engine
// Priority: Gemini (free) → Claude (paid) → throws
// ══════════════════════════════════════════════════════════════════
async function aiAnswer(question, db, { geminiKey, anthropicKey } = {}) {
  if (geminiKey) {
    return await geminiAnswer(question, db, geminiKey);
  }
  if (anthropicKey) {
    return await claudeAnswer(question, db, anthropicKey);
  }
  throw new Error('No AI key configured');
}

module.exports = { aiAnswer, geminiAnswer, claudeAnswer, extractSQL, validateSQL };

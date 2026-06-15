'use strict';
/**
 * free-ai-agent.js — Facto-Bot v2 · Multi-Mode · Hinglish · Self-Learning
 * ──────────────────────────────────────────────────────────────────────────
 * Modes: chat | report | chart | rca
 * Hinglish: auto-normalised before AI processing
 * Self-learning: successful Q→SQL pairs cached in config/ai-cache.json
 *
 * Engines (priority order):
 *   Claude    → ANTHROPIC_API_KEY=sk-ant-...
 *   Groq      → GROQ_API_KEY=gsk_...         (free, fastest)
 *   Gemini    → GEMINI_API_KEY=AIza...        (free, 15 req/min) — gemini-2.0-flash
 *   Ollama    → OLLAMA_URL=http://localhost:11434
 *   Rule-based → built-in fallback (no key needed)
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ─────────────────────────────────────────────────────────────────
// SELF-LEARNING CACHE  (config/ai-cache.json)
// ─────────────────────────────────────────────────────────────────
const CACHE_PATH = path.join(__dirname, '..', 'config', 'ai-cache.json');
let _cache = null;

function loadCache() {
  if (_cache) return _cache;
  try { _cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); }
  catch { _cache = { version: 2, patterns: [] }; }
  return _cache;
}

function saveCache(c) {
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2)); }
  catch(e) { console.warn('[AI-Cache] save failed:', e.message); }
}

function cacheLearn(normalizedQ, sql, engine) {
  try {
    const c = loadCache();
    const key = normalizedQ.slice(0, 220);
    const idx = c.patterns.findIndex(p => p.key === key);
    if (idx >= 0) {
      c.patterns[idx].hits  = (c.patterns[idx].hits || 0) + 1;
      c.patterns[idx].sql   = sql;
      c.patterns[idx].last  = new Date().toISOString();
    } else {
      c.patterns.unshift({ key, sql, engine, hits: 1, learned_at: new Date().toISOString() });
      if (c.patterns.length > 600) c.patterns = c.patterns.slice(0, 600);
    }
    _cache = c;
    saveCache(c);
  } catch { /* non-fatal */ }
}

function cacheLookup(normalizedQ) {
  try {
    const c = loadCache();
    const key = normalizedQ.slice(0, 220);
    // 1. Exact match
    const exact = c.patterns.find(p => p.key === key);
    if (exact) return exact.sql;
    // 2. High word-overlap (≥80% of significant words match)
    const qWords = key.split(/\s+/).filter(w => w.length > 3);
    if (qWords.length >= 3) {
      const qSet = new Set(qWords);
      for (const p of c.patterns) {
        const pWords = p.key.split(/\s+/).filter(w => w.length > 3);
        const overlap = pWords.filter(w => qSet.has(w)).length;
        if (overlap / qWords.length >= 0.8) return p.sql;
      }
    }
  } catch { /* */ }
  return null;
}

// ─────────────────────────────────────────────────────────────────
// HINGLISH NORMALISER
// ─────────────────────────────────────────────────────────────────
const HINGLISH_PHRASES = [
  // Production
  ['parts kitne bane aaj',       'how many parts produced today'],
  ['parts kitne bane',           'how many parts produced'],
  ['aaj ke parts',               "today's parts produced"],
  ['aaj kitne parts bane',       'how many parts produced today'],
  ['kitne parts bane',           'how many parts produced'],
  ['production kitna hua',       'how much production happened'],
  ['aaj ka production',          "today's production"],
  ['abhi tak kitne parts',       'how many parts produced so far'],
  ['parts ki count',             'part count'],
  ['parts ka target',            'parts target'],
  ['target poora hua',           'target achieved'],
  ['target miss hua',            'target missed'],
  // OEE
  ['aaj ka oee kya hai',         "what is today's oee"],
  ['aaj ka oee',                 "today's oee"],
  ['is shift ka oee',            'current shift oee'],
  ['oee kya hai',                'what is oee'],
  ['oee kitna hai',              'what is the oee value'],
  ['oee kya chal raha',          'what is the current oee'],
  // Machine Status
  ['machine band kyun hai',      'why is the machine down'],
  ['machine band kyu hai',       'why is the machine down'],
  ['machine kyu ruki hai',       'why is machine stopped'],
  ['machine band hai',           'machine is stopped'],
  ['machine chal rahi hai',      'machine is running'],
  ['machine abhi kya kar rahi',  'what is machine doing right now'],
  ['machine ka status kya hai',  'what is machine status'],
  ['machine ki condition',       'machine condition status'],
  ['machine ka haal',            'machine current status'],
  ['abhi machine chal rahi',     'is machine running now'],
  // Cycle Time
  ['cycle time kya hai',         'what is the cycle time'],
  ['cycle time kitna hai',       'what is cycle time value'],
  ['ideal cycle time',           'target cycle time'],
  ['target cycle kya hai',       'what is target cycle time'],
  // Downtime
  ['downtime kitna raha',        'how much downtime occurred'],
  ['kitni der band rahi',        'how long was machine stopped'],
  ['band rehne ka time',         'machine downtime duration'],
  ['kab se band hai',            'since when is machine stopped'],
  // Alarm
  ['alarm aaya kya',             'did any alarm occur'],
  ['koi alarm aaya',             'any alarm occurred'],
  ['alarm kya hai',              'what is the alarm'],
  ['alarm ki history',           'alarm history'],
  // Performance / Quality
  ['performance kya hai',        'what is the performance'],
  ['performance kitni hai',      'what is performance value'],
  ['rejection kitni',            'how much rejection'],
  ['quality kya hai',            'what is quality'],
  ['waste kitna',                'how much rejection waste'],
  // RCA
  ['rca karo',                   'root cause analysis'],
  ['root cause kya hai',         'what is root cause'],
  ['kyu hua yeh',                'why did this happen'],
  ['kyun hua',                   'why happened'],
  ['karne ki wajah',             'reason for happening'],
  // Report
  ['report do',                  'generate report'],
  ['report banao',               'create report'],
  ['shift report',               'shift report'],
  // Chart
  ['graph dikhao',               'show chart'],
  ['chart banao',                'create chart'],
  ['graph banao',                'create chart'],
  // Time words
  ['aaj',      'today'],
  ['kal',      'yesterday'],
  ['abhi',     'right now'],
  ['is waqt',  'current'],
  ['is shift', 'current shift'],
  ['pichle',   'last'],
  ['is hafte', 'this week'],
];

// Filler Hindi words to strip after phrase replacement
const HINGLISH_FILLERS = /\b(kya|hai|ka|ki|ke|ko|se|mein|me|bhi|hi|na|nhi|nahi|hain|tha|thi|the|ho|hoga|hogi|hoge|raha|rahi|rahe|karo|karo|bata|bata|dikhao|please|plz|batao|zara|jara|thoda)\b/gi;

function normalizeHinglish(text) {
  let t = text.toLowerCase().trim();
  for (const [hin, eng] of HINGLISH_PHRASES) {
    t = t.replace(new RegExp(hin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), eng);
  }
  t = t.replace(HINGLISH_FILLERS, ' ').replace(/\s+/g, ' ').trim();
  return t || text.toLowerCase().trim();
}

// ─────────────────────────────────────────────────────────────────
// DB SCHEMA  (shared across all AI providers)
// ─────────────────────────────────────────────────────────────────
const DB_SCHEMA = `
You are Facto-Bot, an AI OEE assistant for Demo Machine Hobbing Machine (M-896, Industrial CNC 32iB) at Factory-MIOS Demo, built by Factory-MIOS.

DATABASE: PostgreSQL/TimescaleDB — database "cnc_db"

TABLE 1: cnc_data  — raw machine telemetry (~1 row every 5 seconds)
  machine_id           TEXT    — always filter: WHERE machine_id='MACHINE001'
  time                 TIMESTAMPTZ — use AT TIME ZONE 'Asia/Kolkata' for IST display
  machine_state        TEXT    — 'RUNNING', 'ALARM', 'IDLE', 'EMERGENCY'
  is_running           BOOLEAN
  spindle_speed        NUMERIC — RPM
  feed_rate            NUMERIC — mm/min
  raw_cycle_time_sec   NUMERIC — current cycle counter (resets each cycle)
  last_cycle_time_sec  NUMERIC — last completed cycle time in seconds
  part_count           NUMERIC — CUMULATIVE counter (use MAX-MIN for parts in window)
  alarm_active         BOOLEAN
  alarm_no             TEXT    — alarm code
  program_no           NUMERIC — current program number (1-16)

TABLE 2: oee_results  — pre-calculated OEE per shift (refreshed every 5 min)
  machine_id, shift_date DATE, shift CHAR(1) — 'A' or 'B'
  oee, availability, performance, quality  NUMERIC — percentage 0-100
  parts_produced, target_parts, good_parts, rejection_count  INT
  running_min, downtime_min, avg_cycle_sec, target_cycle_sec NUMERIC
  alarm_count INT, calculated_at TIMESTAMPTZ

TABLE 3: program_master  — ideal cycle times per program
  program_no INT, part_name TEXT, target_cycle_sec NUMERIC, machine_id TEXT='MACHINE001'
  Programs: O0002=128s, O0005=200s, O0006=245s, O0007=150s, O0008=36s,
            O0009=45s, O0010=200s, O0011=255s, O0013=120s, O0016=245s
  ALWAYS JOIN program_master for target_cycle_sec — never hardcode 45.

TABLE 4: cnc_downtime_log  — operator-logged downtime events
  machine_id, shift_date, shift, start_time, end_time, duration_min
  downtime_type (PLANNED/UNPLANNED), reason TEXT, severity (MINOR/SECOND_LEVEL/MAJOR)

TABLE 5: cnc_rejection_log  — quality rejection events
  machine_id, shift_date, shift, rejected_parts INT, rejection_reason TEXT
  defect_type TEXT, severity (MINOR/SECOND_LEVEL/MAJOR)

SHIFT SCHEDULE (IST = UTC+5:30):
  Shift A: 07:00–19:00 (same day)
  Shift B: 19:00–07:00 (next day) — shift_date = day shift STARTED
  Current shift date SQL:
    (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::DATE
    - CASE WHEN EXTRACT(HOUR FROM CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') < 7 THEN 1 ELSE 0 END

ADDITIONAL oee_results COLUMNS (full list):
  running_min, downtime_min, major_downtime_min, minor_downtime_min
  idle_sec, running_sec, downtime_sec
  parts_attainment (attainment % = parts_produced/target_parts*100)
  scrap_rate (rejection %)
  cycle_efficiency, best_cycle_sec, worst_cycle_sec
  shift_start TIMESTAMPTZ, shift_end TIMESTAMPTZ

SHIFT TIME FILTERING (for cnc_data queries by date+shift):
  Shift A: time >= '{date} 07:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata'
           AND time <  '{date} 19:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata'
  Shift B: time >= '{date} 19:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata'
           AND time <  '{next_date} 07:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata'

EXAMPLE QUERIES:
Q: "what programs ran on 30 may 2026 shift b"
A: SELECT cd.program_no, pm.part_name, COUNT(*) AS readings,
     ROUND(AVG(CASE WHEN cd.last_cycle_time_sec>2 THEN cd.last_cycle_time_sec END)::numeric,1) AS avg_cycle_sec,
     COALESCE(pm.target_cycle_sec,0) AS target_cycle_sec
   FROM cnc_data cd
   LEFT JOIN program_master pm ON pm.program_no=cd.program_no AND pm.machine_id='MACHINE001'
   WHERE cd.machine_id='MACHINE001'
     AND cd.time >= '2026-05-30 19:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata'
     AND cd.time <  '2026-05-31 07:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata'
     AND cd.program_no IS NOT NULL
   GROUP BY cd.program_no, pm.part_name, pm.target_cycle_sec
   ORDER BY readings DESC

Q: "OEE on 28 may 2026 shift a"
A: SELECT shift_date, shift, ROUND(oee::numeric,1) AS oee, ROUND(availability::numeric,1) AS availability,
     ROUND(performance::numeric,1) AS performance, ROUND(quality::numeric,1) AS quality,
     parts_produced, target_parts, ROUND(parts_attainment::numeric,1) AS attainment_pct,
     running_min, downtime_min, alarm_count
   FROM oee_results
   WHERE machine_id='MACHINE001' AND shift_date='2026-05-28' AND shift='A'

SQL RULES:
- ONLY SELECT queries — NEVER INSERT/UPDATE/DELETE/DROP/ALTER/CREATE
- ALWAYS filter: WHERE machine_id='MACHINE001'
- Parts in time window: MAX(part_count) - MIN(part_count)  (cumulative counter)
- Display timestamps: time AT TIME ZONE 'Asia/Kolkata'
- Decimals: ROUND(value::numeric, 1)
- NEVER hardcode target_cycle — always join program_master
- For live status: SELECT ... FROM cnc_data WHERE machine_id='MACHINE001' ORDER BY time DESC LIMIT 1
- For date/shift queries on oee_results: use shift_date='YYYY-MM-DD' AND shift='A'/'B'
- For date/shift queries on cnc_data: use AT TIME ZONE shift time bounds (see above)
`;

const SQL_INSTRUCTION = `
Output ONLY a SQL SELECT query inside \`\`\`sql\`\`\` fences. Nothing else.
`;

// ── Mode-specific format instructions ─────────────────────────────
const FORMAT_CHAT = `
You are Facto-Bot, an OEE assistant for Demo Production Machine at Factory-MIOS Demo.
Give a clear, concise answer using:
- Emojis: 🏭 Production, ⏱ Cycle time, 📊 OEE, 🔧 Machine, ✅ Good, ❌ Rejection, ⛔ Downtime, 🕐 Shift
- **Bold** for key numbers
- OEE grade: 🟢 ≥80% World Class, 🟡 65-79% Typical, 🔴 <65% Needs Attention
- Machine state: 🟢 RUNNING, 🔴 ALARM, ⚪ IDLE
- Always state the time period (e.g. "Shift A, 28 May")
- If no data: "No data for this period — Node-RED may not be writing to DB"
`;

const FORMAT_REPORT = `
You are Facto-Bot Report Engine for Factory-MIOS Demo — Demo Production Machine (MACHINE001).
Generate a complete INDUSTRIAL SHIFT REPORT using this exact structure:

╔══════════════════════════════════════════════════╗
║        FACTORY-MIOS DEMO — PRODUCTION REPORT          ║
║  Machine: MACHINE001 | Demo Machine Hobbing M-896            ║
╚══════════════════════════════════════════════════╝

## 1. REPORT HEADER
Report Type | Date | Shift | Generated At

## 2. EXECUTIVE KPI SUMMARY
| KPI            | Actual | Target | Status |
(table with OEE, Availability, Performance, Quality)

## 3. PRODUCTION SUMMARY
| Metric         | Value  |
(Parts Produced, Target, Attainment%, Good Parts, Rejections, Net Available Time)

## 4. DOWNTIME ANALYSIS
Total downtime, breakdown by reason, longest stop event

## 5. CYCLE TIME ANALYSIS
Avg / Best / Worst cycle, Target cycle, Cycle Efficiency%

## 6. ALARM EVENTS
List of alarms with count, first occurrence, last occurrence

## 7. QUALITY ANALYSIS
Rejection rate%, defect types if available

## 8. ROOT CAUSE HIGHLIGHTS
• [2-3 bullet points on the biggest issues found in data]

## 9. RECOMMENDED ACTIONS
1. [Immediate action — do now]
2. [Short-term action — today/tomorrow]
3. [Preventive action — process change]

─────────────────────────────────────────
Report generated by Facto-Bot AI · Factory-MIOS
─────────────────────────────────────────

Use bold numbers, real data only — no assumptions.
`;

const FORMAT_CHART = `
You are Facto-Bot Chart Engine for Factory-MIOS Demo MACHINE001 OEE system.
Based on the SQL results, output a JSON chart config for Chart.js.

Output ONLY valid JSON inside \`\`\`json\`\`\` fences:
{
  "type": "bar" | "line" | "pie" | "doughnut",
  "title": "Descriptive chart title",
  "labels": ["label1", "label2"],
  "datasets": [{
    "label": "Dataset name",
    "data": [numeric, values],
    "backgroundColor": ["#00d4ff","#a855f7","#4488ff","#00ff88","#ffb300","#ff4444"],
    "borderColor": ["#00d4ff"],
    "borderWidth": 2,
    "fill": false
  }],
  "summary": "2-3 sentence plain-text insight about the data shown"
}

Color rules:
- OEE bars: green (#00ff88) if ≥80%, amber (#ffb300) if 65-79%, red (#ff4444) if <65%
- Availability: #00d4ff  Performance: #a855f7  Quality: #4488ff
- Multiple series: cycle through [#00d4ff, #a855f7, #4488ff, #00ff88, #ffb300, #ff4444]
- For time-series (line chart): use a single colour with fill:true
Always include the "summary" field.
`;

const FORMAT_RCA = `
You are Facto-Bot RCA Engine for Factory-MIOS Demo — Demo Production Machine.
Perform a structured Root Cause Analysis based strictly on the DB data provided.

## 🔍 PROBLEM STATEMENT
What went wrong · When · Severity

## 📊 DATA EVIDENCE
Key DB metrics that confirm the problem (use actual numbers)

## 🔎 5-WHY ANALYSIS
- Why 1: [immediate visible symptom]
- Why 2: [cause of Why 1]
- Why 3: [deeper factor]
- Why 4: [contributing root factor]
- Why 5: [fundamental root cause]

## 🎯 ROOT CAUSE
One clear sentence

## ⚡ IMPACT
OEE loss · Production loss · Quality impact (with numbers)

## 🔧 CORRECTIVE ACTIONS (Immediate — do now / today)
1. [Action + owner + deadline]
2. [Action + owner + deadline]

## 🛡️ PREVENTIVE ACTIONS (Long-term — process/maintenance change)
1. [Systemic fix]
2. [Monitoring/alert to add]

## 📣 ESCALATION
Escalate to [role] if not resolved within [timeframe]

Base ALL analysis on actual data. No guesses. If data is insufficient, say so clearly.
`;

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────
function getModeInstruction(mode) {
  switch ((mode || 'chat').toLowerCase()) {
    case 'report': return FORMAT_REPORT;
    case 'chart':  return FORMAT_CHART;
    case 'rca':    return FORMAT_RCA;
    default:       return FORMAT_CHAT;
  }
}

function extractSQL(text) {
  const m = text.match(/```sql\s*([\s\S]*?)```/i);
  if (m) return m[1].trim();
  const s = text.match(/SELECT[\s\S]+?(?:;|$)/i);
  if (s) return s[0].trim().replace(/;$/, '');
  return null;
}

function extractJSON(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/i);
  if (m) { try { return JSON.parse(m[1].trim()); } catch { return null; } }
  // Try bare JSON object
  const bare = text.match(/\{[\s\S]*"type"[\s\S]*"labels"[\s\S]*\}/);
  if (bare) { try { return JSON.parse(bare[0]); } catch { return null; } }
  return null;
}

function validateSQL(sql) {
  if (!sql) throw new Error('No SQL generated by AI');
  const up = sql.toUpperCase();
  for (const kw of ['INSERT','UPDATE','DELETE','DROP','TRUNCATE','ALTER','CREATE','GRANT']) {
    if (new RegExp(`\\b${kw}\\b`).test(up)) throw new Error(`Unsafe keyword: ${kw}`);
  }
  if (!up.trim().startsWith('SELECT')) throw new Error('Only SELECT allowed');
  return sql;
}

function httpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const lib = isHttps ? https : http;
    const u = new URL(url);
    const data = JSON.stringify(body);
    const opts = {
      hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    };
    const req = lib.request(opts, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, data: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

// ─────────────────────────────────────────────────────────────────
// GROQ  (free, fastest — llama-3.3-70b-versatile)
// ─────────────────────────────────────────────────────────────────
async function groqChat(messages, apiKey) {
  const res = await httpPost(
    'https://api.groq.com/openai/v1/chat/completions',
    { Authorization: `Bearer ${apiKey}` },
    { model: 'llama-3.3-70b-versatile', messages, temperature: 0.1, max_tokens: 3000 }
  );
  if (res.status !== 200) throw new Error(`Groq ${res.status}: ${JSON.stringify(res.data)}`);
  return res.data.choices[0].message.content;
}

async function answerWithGroq(question, db, apiKey, mode) {
  const nq = normalizeHinglish(question);

  // 1. Try cache for SQL (chat mode only)
  let sql = null, rows = [], dbErr = null;
  if (mode === 'chat' || mode === 'chart') {
    const cached = cacheLookup(nq);
    if (cached) {
      try { sql = cached; rows = (await db.query(sql)).rows; }
      catch (e) { sql = null; dbErr = null; } // stale cache — retry below
    }
  }

  // 2. Generate SQL via AI if not cached
  if (!sql) {
    const sqlText = await groqChat([
      { role: 'system', content: DB_SCHEMA + SQL_INSTRUCTION },
      { role: 'user',   content: nq },
    ], apiKey);
    try { sql = validateSQL(extractSQL(sqlText)); rows = (await db.query(sql)).rows; }
    catch (e) { dbErr = e.message; }
  }

  // 3. Format answer in the requested mode
  const fmtInstr = getModeInstruction(mode);
  const ctx = dbErr
    ? `Q: "${question}"\nSQL error: ${dbErr}\nTell user data is unavailable.`
    : `Q: "${question}"\nSQL used: ${sql}\nRows (${rows.length}): ${JSON.stringify(rows.slice(0, 40))}`;

  const answer = await groqChat([
    { role: 'system', content: fmtInstr },
    { role: 'user',   content: ctx },
  ], apiKey);

  // 4. Learn
  if (sql && !dbErr && rows.length > 0) cacheLearn(nq, sql, 'groq');

  const chartCfg = (mode === 'chart') ? extractJSON(answer) : null;
  return {
    ok: true,
    text: chartCfg ? (chartCfg.summary || answer) : answer,
    sql, rows: rows.length, engine: 'groq', model: 'llama-3.3-70b-versatile',
    mode: mode || 'chat', chart_config: chartCfg, data: rows.slice(0, 60),
  };
}

// ─────────────────────────────────────────────────────────────────
// OLLAMA  (local, free forever)
// ─────────────────────────────────────────────────────────────────
async function ollamaChat(prompt, model, baseUrl) {
  const res = await httpPost(`${baseUrl}/api/generate`, {},
    { model, prompt, stream: false, options: { temperature: 0.1 } });
  if (res.status !== 200) throw new Error(`Ollama ${res.status}: ${JSON.stringify(res.data)}`);
  return res.data.response || '';
}

async function answerWithOllama(question, db, baseUrl, mode) {
  const model = process.env.OLLAMA_MODEL || 'llama3.2';
  const nq = normalizeHinglish(question);

  const sqlText = await ollamaChat(`${DB_SCHEMA}\n${SQL_INSTRUCTION}\n\nQuestion: ${nq}\n\nSQL:`, model, baseUrl);
  let sql = null, rows = [], dbErr = null;
  try { sql = validateSQL(extractSQL(sqlText)); rows = (await db.query(sql)).rows; }
  catch (e) { dbErr = e.message; }

  const fmtInstr = getModeInstruction(mode);
  const fmtPrompt = `${fmtInstr}\n\nQuestion: "${question}"\n${
    dbErr ? `Error: ${dbErr}` : `SQL: ${sql}\nResults: ${JSON.stringify(rows.slice(0, 40))}`
  }\n\nAnswer:`;
  const answer = await ollamaChat(fmtPrompt, model, baseUrl);

  if (sql && !dbErr && rows.length > 0) cacheLearn(nq, sql, 'ollama');
  const chartCfg = (mode === 'chart') ? extractJSON(answer) : null;
  return {
    ok: true,
    text: chartCfg ? (chartCfg.summary || answer) : answer,
    sql, rows: rows.length, engine: 'ollama', model,
    mode: mode || 'chat', chart_config: chartCfg, data: rows.slice(0, 60),
  };
}

// ─────────────────────────────────────────────────────────────────
// GOOGLE GEMINI  (free: 15 req/min, 1M tokens/day)
// Model: gemini-2.0-flash  (upgraded from 1.5-flash)
// ─────────────────────────────────────────────────────────────────
const GEMINI_MODEL = 'gemini-2.0-flash';

async function geminiChat(prompt, apiKey, maxTokens) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const res = await httpPost(url, {}, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens || 2048 },
  });
  if (res.status !== 200) {
    throw new Error(`Gemini ${res.status}: ${JSON.stringify(res.data?.error || res.data)}`);
  }
  return res.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function answerWithGemini(question, db, apiKey, mode) {
  const nq = normalizeHinglish(question);

  // 1. Cache hit
  let sql = null, rows = [], dbErr = null;
  if (mode === 'chat' || mode === 'chart') {
    const cached = cacheLookup(nq);
    if (cached) {
      try { sql = cached; rows = (await db.query(sql)).rows; }
      catch { sql = null; }
    }
  }

  // 2. Generate SQL
  if (!sql) {
    const sqlText = await geminiChat(`${DB_SCHEMA}\n${SQL_INSTRUCTION}\n\nQuestion: ${nq}`, apiKey, 600);
    try { sql = validateSQL(extractSQL(sqlText)); rows = (await db.query(sql)).rows; }
    catch (e) { dbErr = e.message; }
  }

  // 3. Format
  const fmtInstr = getModeInstruction(mode);
  const maxTok = (mode === 'report' || mode === 'rca') ? 3500 : 2048;
  const ctx = dbErr
    ? `${fmtInstr}\n\nQ: "${question}"\nError: ${dbErr}\nTell user data is unavailable.`
    : `${fmtInstr}\n\nQ: "${question}"\nSQL: ${sql}\nResults (${rows.length} rows): ${JSON.stringify(rows.slice(0, 40))}\n\nAnswer:`;
  const answer = await geminiChat(ctx, apiKey, maxTok);

  // 4. Learn
  if (sql && !dbErr && rows.length > 0) cacheLearn(nq, sql, 'gemini');

  const chartCfg = (mode === 'chart') ? extractJSON(answer) : null;
  return {
    ok: true,
    text: chartCfg ? (chartCfg.summary || answer) : answer,
    sql, rows: rows.length, engine: 'gemini', model: GEMINI_MODEL,
    mode: mode || 'chat', chart_config: chartCfg, data: rows.slice(0, 60),
  };
}

// ─────────────────────────────────────────────────────────────────
// MAIN ROUTER
// ─────────────────────────────────────────────────────────────────
async function freeAIAnswer(question, db, mode) {
  const groq   = process.env.GROQ_API_KEY;
  const gemini = process.env.GEMINI_API_KEY;
  const ollama = process.env.OLLAMA_URL;

  if (groq?.startsWith('gsk_'))    return answerWithGroq(question, db, groq, mode);
  if (gemini?.startsWith('AIza'))  return answerWithGemini(question, db, gemini, mode);
  if (ollama)                      return answerWithOllama(question, db, ollama, mode);
  return null; // no free AI configured
}

// ── Detect active engine ───────────────────────────────────────────
function detectEngine() {
  if (process.env.ANTHROPIC_API_KEY?.startsWith('sk-ant-'))
    return { engine: 'claude',  model: 'claude-sonnet-4-6',         free: false };
  if (process.env.GROQ_API_KEY?.startsWith('gsk_'))
    return { engine: 'groq',    model: 'llama-3.3-70b-versatile',   free: true };
  if (process.env.GEMINI_API_KEY?.startsWith('AIza'))
    return { engine: 'gemini',  model: GEMINI_MODEL,                free: true };
  if (process.env.OLLAMA_URL)
    return { engine: 'ollama',  model: process.env.OLLAMA_MODEL || 'llama3.2', free: true };
  return { engine: 'rule-based', model: null, free: true };
}

module.exports = { freeAIAnswer, detectEngine, normalizeHinglish, cacheLearn, cacheLookup };

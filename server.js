// ═══════════════════════════════════════════════════════════════════
//  Factory-MIOS Dashboard — Express + WebSocket + TimescaleDB
//  Port: 3000  |  Dashboard: http://localhost:3000
// ═══════════════════════════════════════════════════════════════════

// ── Set Node.js timezone to IST unless overridden by environment ──
process.env.TZ = process.env.TZ || 'Asia/Kolkata';
const express   = require('express');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const http      = require('http');
const WebSocket = require('ws');
const fetch     = require('node-fetch');
const path      = require('path');
const fs        = require('fs');
const { Pool }  = require('pg');
const { provisionPlant, generateNodeRedFlow } = require('./lib/db-provisioner');
const { buildExcel, buildHTML, REPORT_LABELS } = require('./lib/report-generator');
const {
  ensureAdminExists, findUser, createUser, verifyPassword,
  generateToken, verifyToken, authMiddleware, loadUsers
} = require('./lib/auth');
const alertEngine  = require('./lib/alert-engine');
const { analyzePlant } = require('./lib/predictive');
const { answer: zotAnswer, SUGGESTIONS: ZOT_SUGGESTIONS } = require('./lib/zot-agent');
const { cncAnswer, CNC_SUGGESTIONS }     = require('./lib/cnc-fallback');
const { aiAnswer, claudeAnswer }          = require('./lib/claude-agent');
const { freeAIAnswer, detectEngine }     = require('./lib/free-ai-agent');
const dataConnectors = require('./lib/data-connectors');
const factoryMiosOnboarding = require('./lib/factory-mios-onboarding');
const setupWizard = require('./lib/setup-wizard');
const ingestionConnectors = require('./lib/ingestion-connectors');
// For MACHINE-001 setup, use CNC suggestions as the default
const SUGGESTIONS = CNC_SUGGESTIONS;

// Load .env if present
try {
  const envPath = require('path').join(__dirname, '.env');
  if (require('fs').existsSync(envPath)) {
    require('fs').readFileSync(envPath,'utf8').split('\n').forEach(line => {
      const [k,...v] = line.split('=');
      if (k && v.length && !process.env[k.trim()]) process.env[k.trim()] = v.join('=').trim();
    });
  }
} catch(e) {}

// ── Alert config helpers ──────────────────────────────────────────
const ALERT_PATH = path.join(__dirname, 'config', 'alert_rules.json');
const HIST_PATH  = path.join(__dirname, 'config', 'alert_history.json');

function loadAlertStore() {
  try { return JSON.parse(fs.readFileSync(ALERT_PATH,'utf8')); }
  catch { return { rules:[], schedules:[], smtp:{}, whatsapp:{} }; }
}
function saveAlertStore(store) { fs.writeFileSync(ALERT_PATH, JSON.stringify(store,null,2)); }
function loadAlertRules() {
  const s = loadAlertStore();
  return { rules: s.rules||[], schedules: s.schedules||[], config: { smtp: s.smtp||{}, whatsapp: s.whatsapp||{} } };
}

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(helmet({
  // Existing pages use inline scripts/styles, so CSP needs a later page-by-page pass.
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '15mb' }));

const generalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX || '1000', 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '20', 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.AI_RATE_LIMIT_MAX || '60', 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
app.use('/api/', generalApiLimiter);

// ── Third-party widget suppression (AITOPIA, chat widgets, etc.) ──
// Injects a style block into every HTML response to hide known chat/bot widgets
// that may be injected by browser extensions or Nginx plugins.
const WIDGET_SUPPRESS_CSS = `<style id="oee-widget-suppress">
  /* AITOPIA & common chat-bot widgets — display:none !important */
  #aitopia-widget,#aitopia-chat,[id*="aitopia"],[class*="aitopia"],
  #hs-beacon,.hs-beacon-container,.HubSpotConversations,
  #tidio-chat,#tidio-chat-iframe,.tidio-widget,
  #crisp-chatbox,.crisp-client,
  #intercom-container,.intercom-lightweight-app,
  #drift-widget,.drift-conductor-item,.drift-frame-controller,
  .chat-widget,.chat-bubble-button,[class*="chat-widget"],[id*="chat-widget"],
  [class*="live-chat"],[id*="live-chat"],
  iframe[src*="aitopia"],iframe[src*="crisp.chat"],iframe[src*="tidio"],
  iframe[src*="hubspot"],iframe[src*="intercom"],iframe[src*="drift"]
  { display:none!important; visibility:hidden!important; pointer-events:none!important; }
</style>`;

app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const _send = res.send.bind(res);
  res.send = function(body) {
    if (typeof body === 'string' && body.includes('</head>')) {
      body = body.replace('</head>', WIDGET_SUPPRESS_CSS + '\n</head>');
    }
    return _send(body);
  };
  next();
});

// ── Config ────────────────────────────────────────────────────────
const PORT         = process.env.PORT || 3000;
const NODE_RED_URL = process.env.NODE_RED_URL || 'http://localhost:1880/api/live';
const PUSH_MS      = 5000;
const APP_TIMEZONE = process.env.TZ || 'Asia/Kolkata';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ALLOW_QUERY_TOKEN_AUTH = process.env.ALLOW_QUERY_TOKEN_AUTH === 'true';

// ── ThingsBoard PE config ─────────────────────────────────────────
// Set TB_TOKEN in .env to override. Token is for device MACHINE-001-Industrial CNC on thingsboard.cloud
const TB_TOKEN   = process.env.TB_TOKEN || 'lvxw5hplwl8uit37e427';
const TB_URL     = `https://thingsboard.cloud/api/v1/${TB_TOKEN}/telemetry`;
const TB_MACHINE = process.env.TB_MACHINE_ID || 'MACHINE001';  // machine_id in oee_results

// ── Shared pool config (timezone set via pg options — no extra query) ──
// Docker and SaaS deployments should provide DATABASE_URL / CNC_DATABASE_URL.
// The individual PG* fallbacks preserve the existing VM/local defaults.
function buildPoolConfig(urlEnvName = 'DATABASE_URL') {
  const connectionString = process.env[urlEnvName] || process.env.DATABASE_URL;
  const base = {
    options: `-c timezone=${APP_TIMEZONE}`,
    max: parseInt(process.env.PGPOOL_MAX || '10', 10),
    idleTimeoutMillis: parseInt(process.env.PGPOOL_IDLE_TIMEOUT_MS || '30000', 10),
    connectionTimeoutMillis: parseInt(process.env.PGPOOL_CONNECTION_TIMEOUT_MS || '5000', 10),
  };

  if (connectionString) {
    return { ...base, connectionString };
  }

  return {
    ...base,
    host:     process.env.PGHOST     || process.env.DB_HOST     || '127.0.0.1',
    port:     parseInt(process.env.PGPORT || process.env.DB_PORT || '5432', 10),
    database: process.env.PGDATABASE || process.env.DB_NAME     || 'cnc_db',
    user:     process.env.PGUSER     || process.env.DB_USER     || 'cnc_user',
    password: process.env.PGPASSWORD || process.env.DB_PASSWORD || 'cnc_pass123',
  };
}

const POOL_CFG     = buildPoolConfig('DATABASE_URL');
const POOL_CNC_CFG = buildPoolConfig('CNC_DATABASE_URL');

// ── Legacy db alias → cnc_db ─────────────────────────────────────
const db = new Pool(POOL_CFG);
db.connect()
  .then(c => { console.log('✅ DB pool (alias)     → cnc_db (Asia/Kolkata)'); c.release(); })
  .catch(e => console.error('⚠️  db pool connect failed:', e.message));

// ── CNC Machine Data (cnc_db) ────────────────────────────────────
const dbCNC = new Pool(POOL_CNC_CFG);
dbCNC.connect()
  .then(c => { console.log('✅ CNC DB connected     → cnc_db (Asia/Kolkata)'); c.release(); })
  .catch(e => console.error('⚠️  cnc_db connection failed:', e.message));

// ── Ensure admin user exists on startup ───────────────────────────
ensureAdminExists().catch(e => console.error('[Auth] Admin setup error:', e.message));

// ══════════════════════════════════════════════════════════════════
//  SHIFT DATE HELPER — returns correct oee_results shift_date
//  Shift A: 07:00–19:00 IST  → shift_date = today
//  Shift B: 19:00–23:59 IST  → shift_date = today
//  Shift B: 00:00–06:59 IST  → shift_date = YESTERDAY (shift started previous evening)
// ══════════════════════════════════════════════════════════════════
function getISTShiftDate(offsetDays = 0) {
  const istNow  = new Date(Date.now() + 5.5 * 3600 * 1000);
  const istHour = istNow.getUTCHours();
  // 00:00–06:59 IST = Shift B that started yesterday at 19:00
  if (istHour < 7) {
    istNow.setUTCDate(istNow.getUTCDate() - 1);
  }
  if (offsetDays) istNow.setUTCDate(istNow.getUTCDate() + offsetDays);
  return istNow.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Returns current IST date string regardless of shift (for display/logging only)
function getTodayIST() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

// ── Public pages (no auth required) ──────────────────────────────
app.get('/welcome', (req, res) => res.sendFile(path.join(__dirname, 'public', 'welcome.html')));
app.get('/setup/connectors', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup-connectors.html')));
app.get('/setup/data', (req, res) => res.sendFile(path.join(__dirname, 'public', 'welcome.html')));
app.get('/setup/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'welcome.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.get('/', (req, res) => {
  if (!setupWizard.isSetupComplete()) return res.redirect('/welcome');
  return res.redirect('/login');
});

// Redirect to welcome until platform setup is frozen
app.use((req, res, next) => {
  if (setupWizard.isSetupComplete()) return next();
  if (setupWizard.isPublicPath(req.path)) return next();
  if (req.path.startsWith('/api/') && !req.path.startsWith('/api/setup') && !req.path.startsWith('/api/ingest/')) {
    return res.status(503).json({ ok: false, error: 'Complete Factory-MIOS setup at /welcome first' });
  }
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.redirect('/welcome');
  }
  next();
});

// ── Auth check middleware for HTML pages ──────────────────────────
function pageAuth(req, res, next) {
  const token = req.cookies?.oee_token || (ALLOW_QUERY_TOKEN_AUTH ? req.query._token : null);
  // Check cookie OR Authorization header
  const header = req.headers.authorization?.replace('Bearer ', '');
  const t = token || header;
  if (!t || !verifyToken(t)) {
    return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  }
  next();
}

// ── Cookie parser (simple, no extra dep) ─────────────────────────
app.use((req, res, next) => {
  req.cookies = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(c => {
    const [k, v] = c.trim().split('=');
    if (k) req.cookies[k.trim()] = decodeURIComponent((v||'').trim());
  });
  next();
});

// ── Serve static files ────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════════════
//  AUTH API
// ══════════════════════════════════════════════════════════════════

// POST /api/auth/login
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const user = findUser(username.toLowerCase().trim());
    if (!user || !user.active) return res.status(401).json({ error: 'Invalid username or password' });

    const match = await verifyPassword(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid username or password' });

    const token = generateToken(user);

    // Set cookie (HttpOnly for security)
    res.setHeader('Set-Cookie', `oee_token=${token}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`);

    console.log(`[Auth] ✅ Login: ${user.username} (${user.role}) → ${user.default_page || '/'}`);
    res.json({
      ok: true, token,
      redirect: user.default_page || '/',
      user: { id: user.id, username: user.username, name: user.name, role: user.role, plant_ids: user.plant_ids, default_page: user.default_page || '/' }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auth/me — verify token + return user info
app.get('/api/auth/me', (req, res) => {
  const token = req.cookies?.oee_token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Invalid or expired token' });
  res.json({ ok: true, user: decoded });
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'oee_token=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

// GET /api/auth/users — list all users (admin only)
app.get('/api/auth/users', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const store = loadUsers();
  const safe  = store.users.map(({ password_hash, ...u }) => u); // never send hashes
  res.json({ ok: true, users: safe });
});

// POST /api/auth/change-password
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  try {
    const { username, new_password } = req.body;
    // Admin can change any user; others can only change their own
    if (req.user.role !== 'admin' && req.user.username !== username) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    const { updatePassword } = require('./lib/auth');
    await updatePassword(username, new_password);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CORS helper ───────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');
}

// Handle OPTIONS preflight for all /api/* routes (required for DELETE/PATCH from browser)
app.options('/api/*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.sendStatus(204);
});

// ══════════════════════════════════════════════════════════════════
//  DATA SOURCE CONNECTORS
//  Supports dashboard sources from JSON, Excel/CSV, MQTT, and SQL.
// ══════════════════════════════════════════════════════════════════
function requireConnectorAdmin(req, res, next) {
  const allowed = ['superadmin', 'admin', 'plant_admin'];
  if (!allowed.includes(req.user?.role)) {
    return res.status(403).json({ ok: false, error: 'Admin role required for data source changes' });
  }
  next();
}

app.get('/api/data-sources/types', authMiddleware, (req, res) => {
  cors(res);
  res.json({ ok: true, types: dataConnectors.SOURCE_TYPES, import_dir: dataConnectors.importDirectory() });
});

app.get('/api/data-sources', authMiddleware, (req, res) => {
  cors(res);
  res.json({ ok: true, sources: dataConnectors.listSources(req.user) });
});

app.post('/api/data-sources', authMiddleware, requireConnectorAdmin, (req, res) => {
  cors(res);
  try {
    const source = dataConnectors.upsertSource(req.body || {}, { user: req.user });
    res.json({ ok: true, source });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/data-sources/preview', authMiddleware, requireConnectorAdmin, async (req, res) => {
  cors(res);
  try {
    const rows = await dataConnectors.previewSource(req.body || {}, { user: req.user });
    res.json({ ok: true, rows, fields: dataConnectors.fieldMetadata(rows), count: rows.length });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/data-sources/:id/preview', authMiddleware, async (req, res) => {
  cors(res);
  try {
    const rows = await dataConnectors.previewSource(req.params.id, { user: req.user });
    res.json({ ok: true, rows, fields: dataConnectors.fieldMetadata(rows), count: rows.length });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/data-sources/:id/data', authMiddleware, async (req, res) => {
  cors(res);
  try {
    const mapping = {
      valueField: req.query.valueField,
      labelField: req.query.labelField,
      timeField: req.query.timeField,
    };
    const payload = await dataConnectors.readSourceData(req.params.id, {
      user: req.user,
      refresh: req.query.refresh === '1' || req.query.refresh === 'true',
      limit: req.query.limit || undefined,
      mapping,
    });
    res.json({ ok: true, ...payload });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.delete('/api/data-sources/:id', authMiddleware, requireConnectorAdmin, (req, res) => {
  cors(res);
  try {
    const removed = dataConnectors.removeSource(req.params.id, { user: req.user });
    res.json({ ok: true, removed });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  FACTORY-MIOS TENANT ONBOARDING TEMPLATES
//  Defines modules/pages/tags/shifts/dashboards during tenant setup.
// ══════════════════════════════════════════════════════════════════
function requireTenantOnboardingAdmin(req, res, next) {
  const allowed = ['superadmin', 'admin'];
  if (!allowed.includes(req.user?.role)) {
    return res.status(403).json({ ok: false, error: 'Admin role required for tenant onboarding' });
  }
  next();
}

app.get('/api/factory-mios/module-templates', authMiddleware, (req, res) => {
  cors(res);
  res.json({ ok: true, modules: factoryMiosOnboarding.listModuleTemplates() });
});

app.post('/api/factory-mios/onboarding/preview', authMiddleware, requireTenantOnboardingAdmin, (req, res) => {
  cors(res);
  try {
    res.json({ ok: true, config: factoryMiosOnboarding.previewTenantOnboarding(req.body || {}) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/factory-mios/onboarding/apply', authMiddleware, requireTenantOnboardingAdmin, (req, res) => {
  cors(res);
  try {
    res.json({ ok: true, config: factoryMiosOnboarding.applyTenantOnboarding(req.body || {}) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  API: Historical data with date/time range
// ══════════════════════════════════════════════════════════════════

// GET /api/history?from=2026-04-22T00:00&to=2026-04-22T23:59&interval=5min
// Returns raw readings for selected range
app.get('/api/history', async (req, res) => {
  cors(res);
  try {
    const from     = req.query.from || new Date(Date.now() - 86400000).toISOString();
    const to       = req.query.to   || new Date().toISOString();
    const interval = req.query.interval || '5 minutes';

    const sql = `
      SELECT
        time_bucket($3::interval, time) AS bucket,
        ROUND(AVG(plant_oee)::numeric,2)          AS plant_oee,
        ROUND(AVG(plant_availability)::numeric,2) AS plant_availability,
        ROUND(AVG(plant_performance)::numeric,2)  AS plant_performance,
        ROUND(AVG(plant_quality)::numeric,2)      AS plant_quality,
        ROUND(AVG(l1_oee)::numeric,2)   AS l1_oee,  ROUND(AVG(l1_avail)::numeric,2) AS l1_avail,
        ROUND(AVG(l1_perf)::numeric,2)  AS l1_perf, ROUND(AVG(l1_qual)::numeric,2)  AS l1_qual,
        ROUND(AVG(l2_oee)::numeric,2)   AS l2_oee,  ROUND(AVG(l2_avail)::numeric,2) AS l2_avail,
        ROUND(AVG(l2_perf)::numeric,2)  AS l2_perf, ROUND(AVG(l2_qual)::numeric,2)  AS l2_qual,
        ROUND(AVG(em1_kw)::numeric,2)   AS em1_kw,  ROUND(AVG(em2_kw)::numeric,2)   AS em2_kw,
        ROUND(AVG(em3_kw)::numeric,2)   AS em3_kw,  ROUND(AVG(em4_kw)::numeric,2)   AS em4_kw,
        ROUND(AVG(em5_kw)::numeric,2)   AS em5_kw,
        ROUND(AVG(em1_kwh)::numeric,2)  AS em1_kwh, ROUND(AVG(em2_kwh)::numeric,2)  AS em2_kwh,
        ROUND(AVG(em3_kwh)::numeric,2)  AS em3_kwh, ROUND(AVG(em4_kwh)::numeric,2)  AS em4_kwh,
        ROUND(AVG(em5_kwh)::numeric,2)  AS em5_kwh,
        ROUND(AVG(em1_pf)::numeric,3)   AS em1_pf,  ROUND(AVG(em2_pf)::numeric,3)   AS em2_pf,
        ROUND(AVG(em3_pf)::numeric,3)   AS em3_pf,  ROUND(AVG(em4_pf)::numeric,3)   AS em4_pf,
        ROUND(AVG(em5_pf)::numeric,3)   AS em5_pf,
        ROUND(AVG(w1_flow)::numeric,2)  AS w1_flow, ROUND(AVG(w2_flow)::numeric,2)  AS w2_flow,
        ROUND(AVG(w3_flow)::numeric,2)  AS w3_flow, ROUND(AVG(w4_flow)::numeric,2)  AS w4_flow,
        ROUND(AVG(w5_flow)::numeric,2)  AS w5_flow,
        ROUND(AVG(m1_vib)::numeric,2)   AS m1_vib,  ROUND(AVG(m1_temp)::numeric,1)  AS m1_temp,
        ROUND(AVG(m1_bearing_temp)::numeric,1) AS m1_bearing_temp,
        ROUND(AVG(m1_current)::numeric,2) AS m1_current, ROUND(AVG(m1_speed)::numeric,0) AS m1_speed,
        MODE() WITHIN GROUP (ORDER BY m1_status) AS m1_status,
        ROUND(AVG(m2_vib)::numeric,2)   AS m2_vib,  ROUND(AVG(m2_temp)::numeric,1)  AS m2_temp,
        ROUND(AVG(m2_bearing_temp)::numeric,1) AS m2_bearing_temp,
        ROUND(AVG(m2_current)::numeric,2) AS m2_current, ROUND(AVG(m2_speed)::numeric,0) AS m2_speed,
        MODE() WITHIN GROUP (ORDER BY m2_status) AS m2_status,
        ROUND(AVG(m3_vib)::numeric,2)   AS m3_vib,  ROUND(AVG(m3_temp)::numeric,1)  AS m3_temp,
        ROUND(AVG(m3_bearing_temp)::numeric,1) AS m3_bearing_temp,
        ROUND(AVG(m3_current)::numeric,2) AS m3_current, ROUND(AVG(m3_speed)::numeric,0) AS m3_speed,
        MODE() WITHIN GROUP (ORDER BY m3_status) AS m3_status,
        ROUND(AVG(m4_vib)::numeric,2)   AS m4_vib,  ROUND(AVG(m4_temp)::numeric,1)  AS m4_temp,
        ROUND(AVG(m4_bearing_temp)::numeric,1) AS m4_bearing_temp,
        ROUND(AVG(m4_current)::numeric,2) AS m4_current, ROUND(AVG(m4_speed)::numeric,0) AS m4_speed,
        MODE() WITHIN GROUP (ORDER BY m4_status) AS m4_status,
        ROUND(AVG(m5_vib)::numeric,2)   AS m5_vib,  ROUND(AVG(m5_temp)::numeric,1)  AS m5_temp,
        ROUND(AVG(m5_bearing_temp)::numeric,1) AS m5_bearing_temp,
        ROUND(AVG(m5_current)::numeric,2) AS m5_current, ROUND(AVG(m5_speed)::numeric,0) AS m5_speed,
        MODE() WITHIN GROUP (ORDER BY m5_status) AS m5_status,
        MAX(total_good)    AS total_good,
        MAX(total_scrap)   AS total_scrap,
        MAX(total_parts)   AS total_parts,
        MAX(total_stops)   AS total_stops,
        MAX(total_stop_min) AS total_stop_min,
        MODE() WITHIN GROUP (ORDER BY shift) AS shift
      FROM plant_readings
      WHERE time >= $1 AND time <= $2
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    const result = await db.query(sql, [from, to, interval]);
    res.json({ ok: true, count: result.rows.length, rows: result.rows });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /api/summary?from=&to=
// Returns single summary row for the selected period
app.get('/api/summary', async (req, res) => {
  cors(res);
  try {
    const from = req.query.from || new Date(Date.now() - 86400000).toISOString();
    const to   = req.query.to   || new Date().toISOString();

    const sql = `
      SELECT
        ROUND(AVG(plant_oee)::numeric, 2)          AS avg_oee,
        ROUND(AVG(plant_availability)::numeric, 2) AS avg_availability,
        ROUND(AVG(plant_performance)::numeric, 2)  AS avg_performance,
        ROUND(AVG(plant_quality)::numeric, 2)      AS avg_quality,
        ROUND(MAX(total_good)::numeric, 0)         AS total_good,
        ROUND(MAX(total_scrap)::numeric, 0)        AS total_scrap,
        ROUND(MAX(total_parts)::numeric, 0)        AS total_parts,
        ROUND(MAX(total_stops)::numeric, 0)        AS total_stops,
        ROUND(MAX(total_stop_min)::numeric, 0)     AS total_stop_min,
        ROUND((MAX(em1_kwh)-MIN(em1_kwh) + MAX(em2_kwh)-MIN(em2_kwh) + MAX(em3_kwh)-MIN(em3_kwh) + MAX(em4_kwh)-MIN(em4_kwh) + MAX(em5_kwh)-MIN(em5_kwh))::numeric, 1) AS total_kwh,
        ROUND(AVG(w1_flow+w2_flow+w3_flow+w4_flow+w5_flow)::numeric, 1) AS avg_water_flow,
        COUNT(*) AS readings
      FROM plant_readings
      WHERE time >= $1 AND time <= $2
    `;

    const result = await db.query(sql, [from, to]);
    res.json({ ok: true, summary: result.rows[0] });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /api/shifts?from=&to=
// Returns OEE breakdown by shift
app.get('/api/shifts', async (req, res) => {
  cors(res);
  try {
    const from = req.query.from || new Date(Date.now() - 86400000).toISOString();
    const to   = req.query.to   || new Date().toISOString();

    const sql = `
      SELECT
        shift,
        ROUND(AVG(plant_oee)::numeric, 2)          AS avg_oee,
        ROUND(AVG(plant_availability)::numeric, 2) AS avg_availability,
        ROUND(AVG(plant_performance)::numeric, 2)  AS avg_performance,
        ROUND(AVG(plant_quality)::numeric, 2)      AS avg_quality,
        MAX(total_good)  AS total_good,
        MAX(total_scrap) AS total_scrap,
        COUNT(*)         AS readings
      FROM plant_readings
      WHERE time >= $1 AND time <= $2
      GROUP BY shift
      ORDER BY shift
    `;

    const result = await db.query(sql, [from, to]);
    // Return both 'shifts' and 'rows' for compatibility with all pages
    res.json({ ok: true, shifts: result.rows, rows: result.rows });
  } catch (e) {
    res.json({ ok: false, error: e.message, shifts: [], rows: [] });
  }
});

// GET /api/machines?from=&to=
// Returns machine health data as rows array (compatible with drill-down pages)
app.get('/api/machines', async (req, res) => {
  cors(res);
  try {
    const from     = req.query.from || new Date(Date.now() - 86400000).toISOString();
    const to       = req.query.to   || new Date().toISOString();
    const interval = req.query.interval || '5 minutes';

    const sql = `
      SELECT
        time_bucket($3::interval, time) AS bucket,
        MODE() WITHIN GROUP (ORDER BY shift) AS shift,
        ROUND(AVG(m1_vib)::numeric,2)   AS m1_vib,  ROUND(AVG(m1_temp)::numeric,1)  AS m1_temp,
        ROUND(AVG(m1_bearing_temp)::numeric,1) AS m1_bearing_temp,
        ROUND(AVG(m1_current)::numeric,2) AS m1_current, ROUND(AVG(m1_speed)::numeric,0) AS m1_speed,
        ROUND(AVG(m1_air_pressure)::numeric,2) AS m1_air_pressure,
        MODE() WITHIN GROUP (ORDER BY m1_status) AS m1_status,
        ROUND(AVG(m2_vib)::numeric,2)   AS m2_vib,  ROUND(AVG(m2_temp)::numeric,1)  AS m2_temp,
        ROUND(AVG(m2_bearing_temp)::numeric,1) AS m2_bearing_temp,
        ROUND(AVG(m2_current)::numeric,2) AS m2_current, ROUND(AVG(m2_speed)::numeric,0) AS m2_speed,
        ROUND(AVG(m2_air_pressure)::numeric,2) AS m2_air_pressure,
        MODE() WITHIN GROUP (ORDER BY m2_status) AS m2_status,
        ROUND(AVG(m3_vib)::numeric,2)   AS m3_vib,  ROUND(AVG(m3_temp)::numeric,1)  AS m3_temp,
        ROUND(AVG(m3_bearing_temp)::numeric,1) AS m3_bearing_temp,
        ROUND(AVG(m3_current)::numeric,2) AS m3_current, ROUND(AVG(m3_speed)::numeric,0) AS m3_speed,
        ROUND(AVG(m3_air_pressure)::numeric,2) AS m3_air_pressure,
        MODE() WITHIN GROUP (ORDER BY m3_status) AS m3_status,
        ROUND(AVG(m4_vib)::numeric,2)   AS m4_vib,  ROUND(AVG(m4_temp)::numeric,1)  AS m4_temp,
        ROUND(AVG(m4_bearing_temp)::numeric,1) AS m4_bearing_temp,
        ROUND(AVG(m4_current)::numeric,2) AS m4_current, ROUND(AVG(m4_speed)::numeric,0) AS m4_speed,
        ROUND(AVG(m4_air_pressure)::numeric,2) AS m4_air_pressure,
        MODE() WITHIN GROUP (ORDER BY m4_status) AS m4_status,
        ROUND(AVG(m5_vib)::numeric,2)   AS m5_vib,  ROUND(AVG(m5_temp)::numeric,1)  AS m5_temp,
        ROUND(AVG(m5_bearing_temp)::numeric,1) AS m5_bearing_temp,
        ROUND(AVG(m5_current)::numeric,2) AS m5_current, ROUND(AVG(m5_speed)::numeric,0) AS m5_speed,
        ROUND(AVG(m5_air_pressure)::numeric,2) AS m5_air_pressure,
        MODE() WITHIN GROUP (ORDER BY m5_status) AS m5_status
      FROM plant_readings
      WHERE time >= $1 AND time <= $2
      GROUP BY bucket ORDER BY bucket ASC
    `;

    const result = await db.query(sql, [from, to, interval]);
    res.json({ ok: true, rows: result.rows, count: result.rows.length });
  } catch (e) {
    res.json({ ok: false, error: e.message, rows: [] });
  }
});

// GET /api/dbstatus  — check DB connection and row count (uses cnc_db)
app.get('/api/dbstatus', async (req, res) => {
  cors(res);
  try {
    const r = await dbCNC.query('SELECT COUNT(*) AS total, MIN(time) AS oldest, MAX(time) AS newest FROM cnc_data');
    res.json({ ok: true, ...r.rows[0] });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Health check ──────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  let dbStatus = { status: 'unknown' };
  try { dbStatus = await setupWizard.testDatabase(db); } catch (e) { dbStatus = { status: 'error', error: e.message }; }
  res.json({
    status: 'ok',
    port: PORT,
    setup_complete: setupWizard.isSetupComplete(),
    database: dbStatus,
  });
});

// ══════════════════════════════════════════════════════════════════
//  FACTORY-MIOS SETUP WIZARD (first-run + superadmin management)
// ══════════════════════════════════════════════════════════════════
function setupAuth(req, res, next) {
  const token = req.cookies?.oee_token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) { req.user = null; return next(); }
  req.user = verifyToken(token);
  next();
}

function requireSetupSuperadmin(req, res, next) {
  if (!req.user || req.user.role !== 'superadmin') {
    return res.status(403).json({ ok: false, error: 'Superadmin login required' });
  }
  next();
}

app.get('/api/setup/status', (req, res) => {
  cors(res);
  res.json({ ok: true, ...setupWizard.getPublicStatus() });
});

app.get('/api/setup/data-format', (req, res) => {
  cors(res);
  res.json({ ok: true, format: setupWizard.getDataFormatDoc(), standard_queries: setupWizard.STANDARD_QUERIES });
});

app.post('/api/setup/test-database', async (req, res) => {
  cors(res);
  try {
    const result = await setupWizard.testDatabase(db);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, status: 'error', error: e.message });
  }
});

app.post('/api/setup/reset-auth', async (req, res) => {
  cors(res);
  try {
    const out = setupWizard.resetSetupAuth();
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/setup/superadmin', async (req, res) => {
  cors(res);
  try {
    const out = await setupWizard.createSuperAdmin(req.body || {});
    const user = findUser(out.user.username);
    const token = user ? generateToken(user) : null;
    if (token) {
      res.setHeader('Set-Cookie', `oee_token=${token}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`);
    }
    res.json({ ok: true, ...out, token, message: 'Superadmin created' });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/setup/plant', setupAuth, async (req, res) => {
  cors(res);
  try {
    if (setupWizard.loadState().frozen) setupWizard.assertSuperadmin(req.user);
    else setupWizard.assertNotFrozen();
    const plant = setupWizard.upsertPlant(req.body || {});
    const provisioned = await setupWizard.provisionPlant(db, plant);
    res.json({ ok: true, plant, provisioned });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/setup/machine', setupAuth, async (req, res) => {
  cors(res);
  try {
    if (setupWizard.loadState().frozen) setupWizard.assertSuperadmin(req.user);
    else setupWizard.assertNotFrozen();
    const { plant_id, ...machine } = req.body || {};
    if (!plant_id) return res.status(400).json({ ok: false, error: 'plant_id required' });
    const saved = setupWizard.upsertMachine(plant_id, machine);
    const provisioned = await setupWizard.provisionMachine(db, plant_id, saved);
    res.json({ ok: true, machine: saved, provisioned });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/setup/data-source', setupAuth, async (req, res) => {
  cors(res);
  try {
    if (setupWizard.loadState().frozen) setupWizard.assertSuperadmin(req.user);
    else setupWizard.assertNotFrozen();
    const { plant_id, ...source } = req.body || {};
    const saved = setupWizard.addDataSource(plant_id, source);
    res.json({ ok: true, source: saved });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/setup/import-format', (req, res) => {
  cors(res);
  res.json({
    ok: true,
    format: ingestionConnectors.EXCEL_FORMAT,
    ingest_post: {
      url: '/api/ingest/v1/{plant_id}/{machine_id}',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Key': '<from setup>' },
      body: { time: new Date().toISOString(), points: { parts_count: 1, kwh_total: 10 } },
    },
  });
});

app.post('/api/setup/connectors/test-mqtt', async (req, res) => {
  cors(res);
  try {
    const out = await ingestionConnectors.testMqtt(req.body || {});
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, status: 'error', error: e.message });
  }
});

app.post('/api/setup/connectors/test-https', async (req, res) => {
  cors(res);
  try {
    const out = await ingestionConnectors.testHttps(req.body || {});
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, status: 'error', error: e.message });
  }
});

app.post('/api/setup/connectors/upload-preview', async (req, res) => {
  cors(res);
  try {
    const { filename, content_base64, header_row } = req.body || {};
    if (!filename || !content_base64) throw new Error('filename and content_base64 required');
    const buffer = Buffer.from(content_base64, 'base64');
    const parsed = await ingestionConnectors.parseUploadBuffer(buffer, filename, header_row || 1);
    const format = ingestionConnectors.detectFormat(parsed.headers, parsed.rows);
    res.json({
      ok: true,
      status: 'connected',
      format,
      headers: parsed.headers,
      raw_rows: parsed.rows.slice(0, 100),
      raw_count: parsed.rows.length,
      required_columns: ingestionConnectors.REQUIRED_LONG_COLUMNS,
    });
  } catch (e) {
    res.status(400).json({ ok: false, status: 'error', error: e.message });
  }
});

app.post('/api/setup/connectors/import-file', setupAuth, async (req, res) => {
  cors(res);
  try {
    if (setupWizard.loadState().frozen) setupWizard.assertSuperadmin(req.user);
    const { plant_id, machine_id, filename, content_base64, header_row, column_map, format } = req.body || {};
    const buffer = Buffer.from(content_base64, 'base64');
    const parsed = await ingestionConnectors.parseUploadBuffer(buffer, filename, header_row || 1);
    const fmt = format || ingestionConnectors.detectFormat(parsed.headers, parsed.rows);
    const normalized = ingestionConnectors.normalizeRows(parsed.rows, column_map || {}, fmt === 'long' ? 'long' : 'wide');
    const out = await setupWizard.importTelemetryRows(db, plant_id, machine_id, normalized);
    const saved = setupWizard.addDataSource(plant_id, {
      type: 'excel_file',
      name: filename,
      file: filename,
      status: 'connected',
      imported_rows: out.inserted,
    });
    const plant = setupWizard.loadState().plants.find(p => p.plant_id === plant_id);
    const mach = plant?.machines?.find(m => m.machine_id === machine_id);
    if (mach) mach.connectivity = { status: 'connected', last_import: new Date().toISOString(), rows: out.inserted };
    setupWizard.saveState(setupWizard.loadState());
    res.json({ ok: true, ...out, source: saved, preview_count: normalized.length });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/setup/connectors/save', setupAuth, async (req, res) => {
  cors(res);
  try {
    if (setupWizard.loadState().frozen) setupWizard.assertSuperadmin(req.user);
    const { plant_id, machine_id, connector_type, config } = req.body || {};
    let entry;
    if (connector_type === 'mqtt') {
      entry = setupWizard.addDataSource(plant_id, {
        ...ingestionConnectors.buildMqttSourceConfig(config),
        machine_id,
        status: config.status || 'configured',
      });
    } else if (connector_type === 'https') {
      entry = setupWizard.addDataSource(plant_id, {
        ...ingestionConnectors.buildHttpsSourceConfig(config),
        machine_id,
        status: config.status || 'configured',
      });
    } else {
      throw new Error('connector_type must be mqtt or https');
    }
    res.json({ ok: true, source: entry });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/setup/connectors/test-ingest', async (req, res) => {
  cors(res);
  try {
    const { plant_id, machine_id, points, time } = req.body || {};
    const key = req.headers['x-ingest-key'] || req.body?.ingest_key;
    if (!setupWizard.verifyIngestKey(key)) {
      return res.status(401).json({ ok: false, error: 'Invalid ingest key — create super admin on /welcome first' });
    }
    const out = await setupWizard.insertPoints(db, plant_id, machine_id, points || { test_point: 1 }, time);
    res.json({ ok: true, message: 'POST ingest successful', ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/setup/sync-source', setupAuth, async (req, res) => {
  cors(res);
  try {
    if (setupWizard.loadState().frozen) setupWizard.assertSuperadmin(req.user);
    const { plant_id, machine_id, source, field_map } = req.body || {};
    const out = await setupWizard.syncSourceToMachine(db, source, plant_id, machine_id, field_map || {});
    const plant = setupWizard.loadState().plants.find(p => p.plant_id === plant_id);
    const mach = plant?.machines?.find(m => m.machine_id === machine_id);
    if (mach) mach.connectivity = { status: 'connected', last_sync: new Date().toISOString(), rows: out.inserted };
    setupWizard.saveState(setupWizard.loadState());
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/setup/machine-data', async (req, res) => {
  cors(res);
  try {
    const { plant_id, machine_id, limit } = req.query;
    const rows = await setupWizard.fetchMachineData(db, plant_id, machine_id, limit);
    res.json({ ok: true, rows, count: rows.length });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/setup/metric-relation', setupAuth, async (req, res) => {
  cors(res);
  try {
    if (setupWizard.loadState().frozen) setupWizard.assertSuperadmin(req.user);
    else setupWizard.assertNotFrozen();
    const rel = setupWizard.addMetricRelation(req.body || {});
    let sample = null;
    if (req.body.sample) sample = setupWizard.evaluateFormula(rel.formula, req.body.sample);
    res.json({ ok: true, relation: rel, sample_result: sample });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/setup/standard-query/:key', async (req, res) => {
  cors(res);
  try {
    const { plant_id, machine_id } = req.query;
    const out = await setupWizard.runStandardQuery(db, plant_id, machine_id, req.params.key);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/setup/dashboard', setupAuth, async (req, res) => {
  cors(res);
  try {
    if (setupWizard.loadState().frozen) setupWizard.assertSuperadmin(req.user);
    else setupWizard.assertNotFrozen();
    const dash = setupWizard.addDashboard(req.body || {});
    res.json({ ok: true, dashboard: dash });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/setup/freeze', setupAuth, requireSetupSuperadmin, async (req, res) => {
  cors(res);
  try {
    const state = await setupWizard.freezeSetup(req.user);
    res.json({ ok: true, message: 'Setup frozen. Platform ready.', state: setupWizard.getPublicStatus() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/setup/unfreeze', setupAuth, requireSetupSuperadmin, (req, res) => {
  cors(res);
  try {
    setupWizard.unfreezeSetup(req.user);
    res.json({ ok: true, message: 'Setup unfrozen for editing.' });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/setup/ingest-key', setupAuth, requireSetupSuperadmin, (req, res) => {
  cors(res);
  const s = setupWizard.loadState();
  res.json({ ok: true, ingest_api_key: s.ingest_api_key, url_pattern: '/api/ingest/v1/{plant_id}/{machine_id}' });
});

// Secure MQTT/HTTPS telemetry ingest
app.post('/api/ingest/v1/:plantId/:machineId', async (req, res) => {
  cors(res);
  try {
    const key = req.headers['x-ingest-key'] || req.query.key;
    if (!setupWizard.verifyIngestKey(key)) {
      return res.status(401).json({ ok: false, error: 'Invalid ingest key' });
    }
    const { time, points } = req.body || {};
    const out = await setupWizard.insertPoints(db, req.params.plantId, req.params.machineId, points, time);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── WebSocket (live data from Node-RED) ───────────────────────────
let cachedData = null;
let dbWriteCounter = 0;

async function fetchAndBroadcast() {
  let data;
  try {
    const r = await fetch(NODE_RED_URL, { timeout: 4000 });
    data = await r.json();
    if (Object.keys(data).length < 3) throw new Error('empty');
    cachedData = { ok: true, ts: Date.now(), data };
  } catch (e) {
    data = generateDemo();
    cachedData = { ok: false, ts: Date.now(), demo: true, data };
  }

  // Push to all WebSocket clients
  const payload = JSON.stringify(cachedData);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
  });

  // ── Save to TimescaleDB every 6 cycles (every 30 seconds) ────────
  dbWriteCounter++;
  if (dbWriteCounter >= 6) {
    dbWriteCounter = 0;
    // saveToDatabase(data); // oee_db dropped — CNC data is stored via Node-RED → cnc_data
  }
}

wss.on('connection', ws => {
  if (cachedData) ws.send(JSON.stringify(cachedData));
  ws.on('close', () => {});
});

// ── GET /api/live — expose cached live data via HTTP (for operator page) ─
app.get('/api/live', (req, res) => {
  cors(res);
  if (cachedData?.data) {
    res.json({ ok: true, ...cachedData.data });
  } else {
    const demo = generateDemo();
    res.json({ ok: true, demo: true, ...demo });
  }
});

setInterval(fetchAndBroadcast, PUSH_MS);
fetchAndBroadcast();

// ── saveToDatabase — DISABLED (oee_db dropped; CNC data via Node-RED → cnc_data) ──
// This function is intentionally a no-op. CNC data is written by the Node-RED pipeline
// directly into cnc_data via MQTT → Function → psql exec. Do NOT re-enable.
function saveToDatabase(_d) { /* no-op — oee_db removed */ }

// ── Demo data fallback ────────────────────────────────────────────
function generateDemo() {
  const now  = new Date();
  const istM = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
  let shift = 'SHIFT_A', el = istM - 360, rem = 480 - el;
  if (istM >= 840 && istM < 1320) { shift = 'SHIFT_B'; el = istM - 840; rem = 480 - el; }
  else if (istM >= 1320 || istM < 360) { shift = 'SHIFT_C'; el = istM >= 1320 ? istM - 1320 : istM + 120; rem = 480 - el; }
  el = Math.max(0, el); rem = Math.max(0, rem);
  const r = (a, b) => +(a + Math.random() * (b - a)).toFixed(2);
  const d = {
    // Wider OEE range (55–92%) ensures histogram covers all buckets incl. critical & excellent
    PLANT_OEE: r(55,92), PLANT_AVAILABILITY: r(70,97), PLANT_PERFORMANCE: r(75,97), PLANT_QUALITY: r(88,99),
    L1_OEE: r(52,90), L1_AVAIL: r(68,96), L1_PERF: r(73,96), L1_QUAL: r(87,99),
    L2_OEE: r(53,91), L2_AVAIL: r(69,96), L2_PERF: r(74,97), L2_QUAL: r(88,99),
    TOTAL_GOOD: Math.round(el*r(42,58)), TOTAL_SCRAP: Math.round(el*r(2,5)),
    TOTAL_PARTS: 0, TOTAL_STOPS: Math.round(r(1,5)), TOTAL_STOP_MIN: Math.round(el*r(0.5,2)),
    SHIFT: shift, ELAPSED_MIN: el, REMAINING_MIN: rem, LIVE_TIME: now.toISOString(),
  };
  d.TOTAL_PARTS = d.TOTAL_GOOD + d.TOTAL_SCRAP;
  // Machine status pattern: M1=OK, M2=OK, M3=WARN, M4=OK, M5=ALERT
  // Sensor values are tuned per status so health-score calc agrees with badge
  const machineProfiles = [
    { mst:'OK',    vib:[1.2,3.5], tmp:[55,68], bt:[48,62], cur:[38,52] }, // M1 healthy
    { mst:'OK',    vib:[1.5,4.0], tmp:[58,70], bt:[50,64], cur:[40,55] }, // M2 healthy
    { mst:'WARN',  vib:[4.5,6.8], tmp:[73,82], bt:[69,78], cur:[55,65] }, // M3 degraded
    { mst:'OK',    vib:[1.0,3.0], tmp:[55,67], bt:[47,61], cur:[38,50] }, // M4 healthy
    { mst:'ALERT', vib:[7.5,10.5],tmp:[86,96], bt:[83,92], cur:[65,75] }, // M5 critical
  ];
  for (let i = 1; i <= 5; i++) {
    const mp = machineProfiles[i-1];
    d[`EM${i}_KW`]=r(30,70); d[`EM${i}_KWH`]=r(25,65); d[`EM${i}_PF`]=r(0.84,0.97); d[`EM${i}_VOLTAGE`]=r(228,244);
    d[`W${i}_FLOW`]=r(6,22); d[`W${i}_TOTAL`]=r(600,1800);
    d[`M${i}_VIB`]=r(...mp.vib); d[`M${i}_TEMP`]=r(...mp.tmp); d[`M${i}_BEARING_TEMP`]=r(...mp.bt);
    d[`M${i}_CURRENT`]=r(...mp.cur); d[`M${i}_SPEED`]=r(1430,1475); d[`M${i}_COOLANT_TEMP`]=r(27,52);
    d[`M${i}_AIR_PRESSURE`]=r(5.0,7.2); d[`M${i}_STATUS`]=mp.mst;
  }
  return d;
}

// ══════════════════════════════════════════════════════════════════
//  DEVICE SETUP API
// ══════════════════════════════════════════════════════════════════

const REGISTRY_PATH = path.join(__dirname, 'config', 'device_registry.json');
const FLOWS_DIR     = path.join(__dirname, 'config', 'generated_flows');

// Ensure dirs exist
if (!fs.existsSync(path.join(__dirname, 'config')))      fs.mkdirSync(path.join(__dirname, 'config'), { recursive: true });
if (!fs.existsSync(FLOWS_DIR))                           fs.mkdirSync(FLOWS_DIR, { recursive: true });

// Load registry
function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); }
  catch { return { tenant_id: 'factory-mios', tenant_name: '', gcp: { data_sink: 'local' }, plants: [] }; }
}
function saveRegistry(reg) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

// ── GET /device-setup ─── serve the wizard page ─────────────────
app.get('/device-setup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'device-setup.html'));
});

// ── POST /api/device/register ─── full plant provisioning ───────
app.post('/api/device/register', async (req, res) => {
  try {
    const payload = req.body;
    const { tenant, plant, user, devices, shifts } = payload;

    if (!tenant?.tenant_id || !plant?.plant_id) {
      return res.status(400).json({ error: 'tenant_id and plant_id are required' });
    }

    // 1. Provision DB schema + tables + columns
    const result = await provisionPlant(db, payload);

    // 2. Update registry JSON
    const registry = loadRegistry();
    registry.tenant_id   = tenant.tenant_id;
    registry.tenant_name = tenant.tenant_name;

    const existing = registry.plants.findIndex(p => p.plant_id === plant.plant_id);
    const plantEntry = {
      plant_id:           plant.plant_id,
      unique_db_schema:   result.schema_name,
      plant_name:         plant.plant_name,
      company_name:       tenant.tenant_name,
      location:           plant.location,
      gps:                plant.gps,
      timezone:           plant.timezone,
      production_lines:   plant.production_lines,
      planned_uptime_hrs: plant.planned_uptime_hrs,
      active:             true,
      created_at:         new Date().toISOString(),
      users:              [{ username: user.username, role: user.role, email: user.email, phone: user.phone, alerts: user.alerts }],
      shifts:             shifts,
      devices:            devices,
    };
    if (existing >= 0) registry.plants[existing] = plantEntry;
    else registry.plants.push(plantEntry);
    saveRegistry(registry);

    // 3. Create login user for this plant
    if (user?.username && user?.password) {
      try {
        await createUser({
          username:  user.username,
          password:  user.password,
          name:      user.name || user.username,
          role:      user.role || 'plant_admin',
          email:     user.email || '',
          phone:     user.phone || '',
          alerts:    user.alerts || 'both',
          plant_ids: [plant.plant_id],
        });
        console.log(`[Auth] ✅ User created: ${user.username} → plant ${plant.plant_id}`);
      } catch (userErr) {
        // User might already exist — update their plant access instead
        console.warn(`[Auth] User ${user.username} already exists — skipping creation`);
      }
    }

    // 4. Generate Node-RED flow JSON
    const flowNodes = generateNodeRedFlow(result.schema_name, tenant, plant, devices);
    const flowFile  = path.join(FLOWS_DIR, `${result.schema_name}_flow.json`);
    fs.writeFileSync(flowFile, JSON.stringify(flowNodes, null, 2));

    console.log(`[Setup] ✅ Plant provisioned: ${result.schema_name} — ${result.columns_created} columns`);

    res.json({
      ok:              true,
      schema:          result.schema_name,
      table:           result.full_table,
      columns_created: result.columns_created,
      devices_count:   result.devices_count,
      nodered_flow:    `config/generated_flows/${result.schema_name}_flow.json`,
      gcp_topic_stub:  result.gcp_topic_stub,
    });

  } catch (err) {
    console.error('[Setup] ❌ Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/devices ─── list all registered plants & devices ───
// GET /api/plants — list all plants from registry
app.get('/api/plants', (req, res) => {
  cors(res);
  try {
    const registry = loadRegistry();
    res.json({ ok: true, plants: registry.plants || [], tenant_id: registry.tenant_id, tenant_name: registry.tenant_name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/devices', (req, res) => {
  cors(res);
  try {
    const registry = loadRegistry();
    res.json({ ok: true, registry });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/plant/:plantId/status ─── live + DB row count ──────
app.get('/api/plant/:plantId/status', async (req, res) => {
  cors(res);
  try {
    const registry = loadRegistry();
    const plant    = registry.plants.find(p => p.plant_id === req.params.plantId);
    if (!plant) return res.status(404).json({ error: 'Plant not found' });

    const schema = plant.unique_db_schema;
    const row    = await db.query(`SELECT COUNT(*) AS total FROM "${schema}"."device_readings"`);
    res.json({ ok: true, plant_id: plant.plant_id, plant_name: plant.plant_name, schema, total_rows: parseInt(row.rows[0].total) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/plant/:plantId/data ─── last N readings ────────────
app.get('/api/plant/:plantId/data', async (req, res) => {
  cors(res);
  try {
    const registry = loadRegistry();
    const plant    = registry.plants.find(p => p.plant_id === req.params.plantId);
    if (!plant) return res.status(404).json({ error: 'Plant not found' });

    const schema = plant.unique_db_schema;
    const limit  = Math.min(parseInt(req.query.limit) || 100, 1000);
    const rows   = await db.query(
      `SELECT * FROM "${schema}"."device_readings" ORDER BY time DESC LIMIT $1`, [limit]
    );
    res.json({ ok: true, plant_id: plant.plant_id, count: rows.rows.length, data: rows.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/plant/:plantId ─── get single plant (for edit pre-fill)
app.get('/api/plant/:plantId', (req, res) => {
  cors(res);
  try {
    const registry = loadRegistry();
    const plant    = registry.plants.find(p => p.plant_id === req.params.plantId);
    if (!plant) return res.status(404).json({ error: 'Plant not found' });
    res.json({ ok: true, plant, tenant_id: registry.tenant_id, tenant_name: registry.tenant_name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/plant/:plantId ─── remove from registry ─────────
// ?hard=true also drops the entire DB schema (all data permanently deleted)
app.delete('/api/plant/:plantId', async (req, res) => {
  cors(res);
  try {
    const registry  = loadRegistry();
    const idx       = registry.plants.findIndex(p => p.plant_id === req.params.plantId);
    if (idx === -1) return res.status(404).json({ error: 'Plant not found' });

    const removed   = registry.plants.splice(idx, 1)[0];
    const schema    = removed.unique_db_schema || `${registry.tenant_id}_${removed.plant_id}`;
    const hardDelete = req.query.hard === 'true';

    // Hard delete — drop entire DB schema + all tables + all data
    if (hardDelete) {
      try {
        await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        console.log(`[Setup] 💥 DB schema dropped: ${schema}`);
      } catch (dbErr) {
        console.error(`[Setup] ❌ Failed to drop schema ${schema}:`, dbErr.message);
        return res.status(500).json({ error: `Registry removed but DB drop failed: ${dbErr.message}` });
      }
    }

    saveRegistry(registry);
    console.log(`[Setup] 🗑️ Plant deleted: ${removed.plant_id} | hard=${hardDelete}`);

    res.json({
      ok:         true,
      deleted:    removed.plant_id,
      hard:       hardDelete,
      db_dropped: hardDelete ? schema : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /api/plant/:plantId/toggle ─── activate / deactivate ──
app.patch('/api/plant/:plantId/toggle', (req, res) => {
  cors(res);
  try {
    const registry = loadRegistry();
    const plant    = registry.plants.find(p => p.plant_id === req.params.plantId);
    if (!plant) return res.status(404).json({ error: 'Plant not found' });
    plant.active   = !plant.active;
    saveRegistry(registry);
    res.json({ ok: true, plant_id: plant.plant_id, active: plant.active });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  USER MANAGEMENT API (Admin only)
// ══════════════════════════════════════════════════════════════════

app.get('/users', pageAuth, (req,res) => res.sendFile(path.join(__dirname,'public','users.html')));

// GET /api/auth/users — list all users (admin only)
// Already defined above — skip duplicate

// POST /api/auth/users — create user
app.post('/api/auth/users', authMiddleware, async (req,res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error:'Admin only' });
  try {
    const { name, username, password, role, email, phone, alerts, plant_ids } = req.body;
    if (!username || !password) return res.status(400).json({ error:'username and password required' });
    const user = await createUser({ username, password, name, role, email, phone, alerts, plant_ids });
    const { password_hash, ...safe } = user;
    res.json({ ok:true, user:safe });
  } catch(e) { res.status(400).json({ error:e.message }); }
});

// PUT /api/auth/users/:id — update user
app.put('/api/auth/users/:id', authMiddleware, async (req,res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error:'Admin only' });
  try {
    const { loadUsers: lu, saveUsers: su } = require('./lib/auth');
    const store = lu(); const idx = store.users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error:'User not found' });
    const { password, ...fields } = req.body;
    Object.assign(store.users[idx], fields);
    if (password) { const { hashPassword } = require('./lib/auth'); store.users[idx].password_hash = await hashPassword(password); }
    su(store);
    const { password_hash, ...safe } = store.users[idx];
    res.json({ ok:true, user:safe });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// DELETE /api/auth/users/:id
app.delete('/api/auth/users/:id', authMiddleware, (req,res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error:'Admin only' });
  const { loadUsers: lu, saveUsers: su } = require('./lib/auth');
  const store = lu();
  const user  = store.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error:'User not found' });
  if (user.username === 'admin') return res.status(400).json({ error:'Cannot delete system admin' });
  store.users = store.users.filter(u => u.id !== req.params.id);
  su(store); res.json({ ok:true });
});

// PATCH /api/auth/users/:id/toggle — activate/deactivate
app.patch('/api/auth/users/:id/toggle', authMiddleware, (req,res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error:'Admin only' });
  const { loadUsers: lu, saveUsers: su } = require('./lib/auth');
  const store = lu(); const user = store.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error:'Not found' });
  user.active = !user.active; su(store);
  res.json({ ok:true, active:user.active });
});

// ══════════════════════════════════════════════════════════════════
//  MULTI-TENANT: helper to filter plant access per user
// ══════════════════════════════════════════════════════════════════
function getAuthorizedPlants(req) {
  // Admin sees all plants
  if (req.user?.role === 'admin' || !req.user) return null; // null = all
  return req.user.plant_ids || [];
}

// ══════════════════════════════════════════════════════════════════
//  PREDICTIVE MAINTENANCE API
// ══════════════════════════════════════════════════════════════════

app.get('/predictive', pageAuth, (req,res) => res.sendFile(path.join(__dirname,'public','predictive.html')));

// GET /api/predict/analysis — full machine health analysis
app.get('/api/predict/analysis', async (req,res) => {
  cors(res);
  try {
    const hours = parseInt(req.query.hours) || 4;
    const from  = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const to    = new Date().toISOString();

    const result = await db.query(`
      SELECT time AS bucket,
        m1_vib, m1_temp, m1_bearing_temp, m1_current, m1_speed, m1_coolant_temp, m1_air_pressure, m1_status,
        m2_vib, m2_temp, m2_bearing_temp, m2_current, m2_speed, m2_coolant_temp, m2_air_pressure, m2_status,
        m3_vib, m3_temp, m3_bearing_temp, m3_current, m3_speed, m3_coolant_temp, m3_air_pressure, m3_status,
        m4_vib, m4_temp, m4_bearing_temp, m4_current, m4_speed, m4_coolant_temp, m4_air_pressure, m4_status,
        m5_vib, m5_temp, m5_bearing_temp, m5_current, m5_speed, m5_coolant_temp, m5_air_pressure, m5_status
      FROM plant_readings
      WHERE time >= $1 AND time <= $2
      ORDER BY time ASC
      LIMIT 500`, [from, to]);

    const readings = result.rows;
    const analysis = analyzePlant(readings);
    res.json({ ok:true, analysis, readings: readings.slice(-50) });
  } catch(e) {
    console.error('[Predict]', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  NODE-RED FLOW AUTO-PUSH
// ══════════════════════════════════════════════════════════════════

// POST /api/nodered/push-flow/:schemaName — push generated flow to Node-RED
app.post('/api/nodered/push-flow/:schemaName', async (req,res) => {
  cors(res);
  try {
    const flowFile = path.join(__dirname, 'config', 'generated_flows', `${req.params.schemaName}_flow.json`);
    if (!fs.existsSync(flowFile)) return res.status(404).json({ error: 'Flow file not found. Register the plant first.' });

    const flowNodes = JSON.parse(fs.readFileSync(flowFile, 'utf8'));
    const flowBody  = JSON.stringify(flowNodes);

    // Push to Node-RED via its API
    const nodeRedUrl = `${process.env.NODE_RED_URL?.replace('/api/live','') || 'http://localhost:1880'}/flows`;
    const nrFetch = await fetch(nodeRedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Node-RED-Deployment-Type': 'nodes' },
      body: flowBody,
    });

    if (nrFetch.ok) {
      res.json({ ok:true, message:`Flow "${req.params.schemaName}" pushed to Node-RED successfully` });
    } else {
      const text = await nrFetch.text();
      res.status(500).json({ error: `Node-RED error: ${text}` });
    }
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// GET /api/nodered/flows — list existing Node-RED flows
app.get('/api/nodered/flows', async (req,res) => {
  cors(res);
  try {
    const nodeRedUrl = `${process.env.NODE_RED_URL?.replace('/api/live','') || 'http://localhost:1880'}/flows`;
    const nrFetch = await fetch(nodeRedUrl, { headers: { 'Content-Type': 'application/json' } });
    const flows   = await nrFetch.json();
    const tabs    = flows.filter(n => n.type === 'tab').map(t => ({ id:t.id, label:t.label, disabled:t.disabled }));
    res.json({ ok:true, flows:tabs });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Role-based dashboard pages ───────────────────────────────────
app.get('/connectivity',  pageAuth, (req,res)=>res.sendFile(path.join(__dirname,'public','connectivity.html')));
app.get('/oee-drilldown', pageAuth, (req,res)=>res.sendFile(path.join(__dirname,'public','oee-drilldown.html')));
app.get('/operator',      (req,res)=>res.sendFile(path.join(__dirname,'public','operator.html')));  // no auth — TV display
app.get('/supervisor',    pageAuth, (req,res)=>res.sendFile(path.join(__dirname,'public','supervisor.html')));
app.get('/executive',     pageAuth, (req,res)=>res.sendFile(path.join(__dirname,'public','executive.html')));
app.get('/shift-log',     pageAuth, (req,res)=>res.sendFile(path.join(__dirname,'public','shift-log.html')));
// ── New pages: AI Chat, Manager, Digital Twin, Super Admin ───────
app.get('/chat',          pageAuth, (req,res)=>res.sendFile(path.join(__dirname,'public','chat.html')));
app.get('/manager',       pageAuth, (req,res)=>res.sendFile(path.join(__dirname,'public','manager.html')));
app.get('/digital-twin',  pageAuth, (req,res)=>res.sendFile(path.join(__dirname,'public','digital-twin.html')));
app.get('/super-admin',       pageAuth, (req,res)=>res.sendFile(path.join(__dirname,'public','super-admin.html')));
app.get('/dashboard-builder', pageAuth, (req,res)=>res.sendFile(path.join(__dirname,'public','dashboard-builder.html')));
app.get('/downtime-log',  pageAuth, (req,res)=>res.sendFile(path.join(__dirname,'public','downtime-log.html')));
app.get('/quality-entry', pageAuth, (req,res)=>res.sendFile(path.join(__dirname,'public','quality-entry.html')));
app.get('/master-data',   pageAuth, (req,res)=>res.sendFile(path.join(__dirname,'public','master-data.html')));

// ── CNC Monitor page ─────────────────────────────────────────────
app.get('/cnc-monitor', pageAuth, (req,res)=>res.sendFile(path.join(__dirname,'public','cnc-monitor.html')));

// ── CNC API: latest single reading ───────────────────────────────
app.get('/api/cnc/live', async (req,res) => {
  try {
    const machine = req.query.machine || 'MACHINE001';
    // Latest row
    const rLive = await dbCNC.query(
      `SELECT time, machine_id, machine_state, is_running, part_count,
              last_cycle_time_sec, raw_cycle_time_sec,
              spindle_speed, feed_rate,
              alarm_active, alarm_no, program_no,
              auto_mode, idle_time_sec, run_status
       FROM cnc_data WHERE machine_id=$1 ORDER BY time DESC LIMIT 1`,
      [machine]
    );
    // Shift cycle stats — from current IST shift start (not a flat 12h window)
    const rCycle = await dbCNC.query(
      `WITH shift_start AS (
         SELECT CASE
           WHEN EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Kolkata') >= 7
            AND EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Kolkata') < 19
           THEN (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE + TIME '07:00:00'
                 - INTERVAL '5 hours 30 minutes'
           WHEN EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Kolkata') >= 19
           THEN (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE + TIME '19:00:00'
                 - INTERVAL '5 hours 30 minutes'
           ELSE ((NOW() AT TIME ZONE 'Asia/Kolkata')::DATE - 1) + TIME '19:00:00'
                 - INTERVAL '5 hours 30 minutes'
         END AS start_utc
       )
       SELECT
         ROUND(AVG(last_cycle_time_sec)::numeric, 1) AS avg_cycle,
         ROUND(MIN(last_cycle_time_sec)::numeric, 1) AS best_cycle,
         ROUND(MAX(last_cycle_time_sec)::numeric, 1) AS worst_cycle,
         COUNT(*)                                    AS cycle_readings
       FROM cnc_data, shift_start
       WHERE machine_id=$1
         AND last_cycle_time_sec > 0
         AND last_cycle_time_sec < 3600
         AND time >= shift_start.start_utc`,
      [machine]
    );
    // Machine state breakdown (last 8 hours)
    const rStates = await dbCNC.query(
      `SELECT machine_state,
              COUNT(*) AS readings,
              ROUND(COUNT(*)*100.0/SUM(COUNT(*)) OVER(), 1) AS pct
       FROM cnc_data
       WHERE machine_id=$1 AND time >= NOW() - INTERVAL '8 hours'
       GROUP BY machine_state ORDER BY readings DESC`,
      [machine]
    );

    // ── Shift downtime: total non-running seconds this shift ─────────
    // Each row ≈ 5 sec sample. Rows where state NOT IN (RUNNING/AUTO/BUSY) = downtime.
    const rDowntime = await dbCNC.query(
      `WITH shift_start AS (
         SELECT CASE
           WHEN EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Kolkata') >= 7
            AND EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Kolkata') < 19
           THEN (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE + TIME '07:00:00'
                 - INTERVAL '5 hours 30 minutes'
           WHEN EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Kolkata') >= 19
           THEN (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE + TIME '19:00:00'
                 - INTERVAL '5 hours 30 minutes'
           ELSE ((NOW() AT TIME ZONE 'Asia/Kolkata')::DATE - 1) + TIME '19:00:00'
                 - INTERVAL '5 hours 30 minutes'
         END AS start_utc
       )
       SELECT
         -- Each data row = ~5 sec sample interval
         COUNT(*) FILTER (
           WHERE UPPER(COALESCE(machine_state,'')) NOT IN ('RUNNING','AUTO','BUSY')
             AND machine_state IS NOT NULL AND machine_state <> ''
         ) * 5 AS downtime_sec,
         COUNT(*) FILTER (
           WHERE UPPER(COALESCE(machine_state,'')) IN ('RUNNING','AUTO','BUSY')
         ) * 5 AS running_sec,
         COUNT(*) * 5 AS total_sec
       FROM cnc_data, shift_start
       WHERE machine_id=$1 AND time >= shift_start.start_utc`,
      [machine]
    );

    const m  = rLive.rows[0]     || null;
    const c  = rCycle.rows[0]    || {};
    const dt = rDowntime.rows[0] || {};

    res.json({
      ok: true,
      machine: m,
      cycle_stats: {
        avg:   c.avg_cycle   != null ? parseFloat(c.avg_cycle)   : null,
        best:  c.best_cycle  != null ? parseFloat(c.best_cycle)  : null,
        worst: c.worst_cycle != null ? parseFloat(c.worst_cycle) : null,
        readings: c.cycle_readings || 0
      },
      shift_downtime: {
        downtime_sec: parseInt(dt.downtime_sec) || 0,
        running_sec:  parseInt(dt.running_sec)  || 0,
        total_sec:    parseInt(dt.total_sec)    || 0,
        downtime_min: Math.round((parseInt(dt.downtime_sec) || 0) / 60),
      },
      state_breakdown: rStates.rows
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CNC API: trend data (last N minutes) ─────────────────────────
app.get('/api/cnc/trend', async (req,res) => {
  try {
    const machine = req.query.machine || 'MACHINE001';
    const minutes = parseInt(req.query.minutes) || 60;
    const r = await dbCNC.query(
      `SELECT time_bucket('30 seconds', time) AS bucket,
              AVG(spindle_speed)       AS spindle_speed,
              AVG(feed_rate)           AS feed_rate,
              AVG(raw_cycle_time_sec)  AS raw_cycle_time_sec,
              MAX(part_count)          AS part_count,
              MAX(last_cycle_time_sec) AS last_cycle_time_sec
       FROM cnc_data
       WHERE machine_id=$1 AND time > NOW() - ($2 || ' minutes')::interval
       GROUP BY bucket ORDER BY bucket ASC`,
      [machine, minutes]
    );
    res.json({ ok: true, data: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CNC API: hourly shift data — date+shift aware ──────────────────
// GET /api/cnc/hourly-shift?date=YYYY-MM-DD&shift=A|B&machine=MACHINE-001
// Returns one row per IST hour bucket for the given shift window.
// Shift A: 07:00–19:00 IST = 01:30–13:30 UTC (same date)
// Shift B: 19:00 IST date → 07:00 IST (date+1) = 13:30 UTC date → 01:30 UTC (date+1)
app.get('/api/cnc/hourly-shift', async (req, res) => {
  try {
    const machine  = req.query.machine || 'MACHINE001';
    const dateStr  = req.query.date || new Date().toLocaleDateString('en-CA');
    const shift    = (req.query.shift || 'A').toUpperCase() === 'B' ? 'B' : 'A';

    // Build UTC window from IST shift boundaries
    // IST = UTC + 05:30, so IST 07:00 = UTC 01:30, IST 19:00 = UTC 13:30
    let tsFrom, tsTo;
    if (shift === 'A') {
      // Shift A: 07:00–19:00 IST on dateStr
      tsFrom = `${dateStr}T01:30:00Z`;          // 07:00 IST → UTC
      tsTo   = `${dateStr}T13:30:00Z`;          // 19:00 IST → UTC
    } else {
      // Shift B: 19:00 IST dateStr → 07:00 IST (dateStr+1 day)
      const nextDay = new Date(dateStr + 'T00:00:00Z');
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      const nextDateStr = nextDay.toISOString().slice(0, 10);
      tsFrom = `${dateStr}T13:30:00Z`;          // 19:00 IST → UTC
      tsTo   = `${nextDateStr}T01:30:00Z`;      // 07:00 IST next day → UTC
    }

    // ── IST-aligned 1-hour buckets ────────────────────────────────────
    // time_bucket without offset snaps to UTC hours (01:00, 02:00…).
    // IST = UTC+5:30, so IST 07:00 = UTC 01:30 — NOT on a UTC hour boundary.
    // Adding INTERVAL '5:30' as offset shifts bucket starts to align with IST:
    //   bucket 01:30 UTC = 07:00 IST  ✓
    //   bucket 02:30 UTC = 08:00 IST  ✓  … etc.
    // LEAST(tsTo, NOW()) prevents returning data for future hours.
    const r = await dbCNC.query(
      `SELECT
         time_bucket('1 hour', time, INTERVAL '5 hours 30 minutes') AS bucket,
         MIN(time AT TIME ZONE 'Asia/Kolkata')               AS hour_start_ist,
         MIN(part_count)                                    AS parts_min,
         MAX(part_count)                                    AS parts_max,
         MAX(part_count) - MIN(part_count)                  AS parts_made,
         ROUND(AVG(CASE WHEN last_cycle_time_sec>5 AND last_cycle_time_sec<300
                        THEN last_cycle_time_sec END)::numeric, 1) AS avg_cycle_sec,
         ROUND(MIN(CASE WHEN last_cycle_time_sec>5 AND last_cycle_time_sec<300
                        THEN last_cycle_time_sec END)::numeric, 1) AS best_cycle_sec,
         ROUND(AVG(spindle_speed)::numeric, 0)              AS avg_spindle,
         ROUND(AVG(feed_rate)::numeric, 0)                  AS avg_feed,
         ROUND(100.0 * SUM(CASE WHEN spindle_speed>0 THEN 1 ELSE 0 END)::numeric
               / NULLIF(COUNT(*),0), 1)                     AS running_pct,
         MAX(alarm_no)                                      AS max_alarm_no,
         SUM(CASE WHEN alarm_active THEN 1 ELSE 0 END)      AS alarm_count,
         MODE() WITHIN GROUP (ORDER BY program_no)          AS top_program_no,
         COUNT(*)                                           AS readings
       FROM cnc_data
       WHERE machine_id = $1
         AND time >= $2::timestamptz
         AND time <  LEAST($3::timestamptz, NOW())
       GROUP BY time_bucket('1 hour', time, INTERVAL '5 hours 30 minutes')
       ORDER BY bucket ASC`,
      [machine, tsFrom, tsTo]
    );

    res.json({ ok: true, shift, date: dateStr, rows: r.rows });
  } catch(e) {
    console.error('[hourly-shift]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── CNC API: part count summary today ────────────────────────────
app.get('/api/cnc/summary', async (req,res) => {
  try {
    const machine = req.query.machine || 'MACHINE001';
    const r = await dbCNC.query(
      `SELECT
         MAX(part_count)                    AS total_parts,
         MAX(part_count) - MIN(part_count)  AS parts_this_session,
         AVG(last_cycle_time_sec)           AS avg_cycle_time,
         MIN(last_cycle_time_sec)           AS best_cycle_time,
         SUM(CASE WHEN is_running THEN 1 ELSE 0 END)::float / COUNT(*) * 100 AS availability_pct,
         COUNT(*) AS total_readings
       FROM cnc_data
       WHERE machine_id=$1 AND time > NOW() - INTERVAL '8 hours'`,
      [machine]
    );
    res.json({ ok: true, data: r.rows[0] || {} });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CNC API: alarm history ────────────────────────────────────────
app.get('/api/cnc/alarms', async (req,res) => {
  try {
    const machine = req.query.machine || 'MACHINE001';
    const limit   = parseInt(req.query.limit) || 20;
    // Current IST shift window: Shift A = 07:00-19:00, Shift B = 19:00-07:00 next day
    // We show alarms from the current shift start (IST-aware) to now
    const r = await dbCNC.query(
      `WITH shift_start AS (
         SELECT
           CASE
             -- Shift A: 07:00 IST today
             WHEN EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Kolkata') >= 7
              AND EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Kolkata') < 19
             THEN (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE + TIME '07:00:00'
                   - INTERVAL '5 hours 30 minutes'
             -- Shift B before midnight: 19:00 IST today
             WHEN EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Kolkata') >= 19
             THEN (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE + TIME '19:00:00'
                   - INTERVAL '5 hours 30 minutes'
             -- Shift B after midnight: 19:00 IST yesterday
             ELSE ((NOW() AT TIME ZONE 'Asia/Kolkata')::DATE - 1) + TIME '19:00:00'
                   - INTERVAL '5 hours 30 minutes'
           END AS start_utc
       )
       SELECT c.time, c.alarm_no, c.alarm_active, c.machine_state, c.program_no,
              c.time AT TIME ZONE 'Asia/Kolkata' AS time_ist
       FROM cnc_data c, shift_start s
       WHERE c.machine_id = $1
         AND c.time >= s.start_utc
         AND (c.alarm_active = true OR c.machine_state = 'ALARM')
       ORDER BY c.time DESC
       LIMIT $2`,
      [machine, limit]
    );
    res.json({ ok: true, data: r.rows, alarms: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});



// ── GET /shifts ──────────────────────────────────────────────────
app.get('/shifts', pageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'shifts.html'));
});

// ── GET /reports ─────────────────────────────────────────────────
app.get('/reports', pageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reports.html'));
});

// ── GET /api/shifts — shift-wise KPI from DB ─────────────────────
app.get('/api/shifts', async (req, res) => {
  cors(res);
  try {
    const range = req.query.range || 'today';
    let from, to = new Date().toISOString();
    const now = new Date();
    if (range === 'today') {
      const sod = new Date(now); sod.setHours(0,0,0,0);
      from = sod.toISOString();
    } else if (range === 'last_7d') {
      const l = new Date(now); l.setDate(l.getDate()-7);
      from = l.toISOString();
    } else {
      from = req.query.from || new Date(Date.now()-86400000).toISOString();
      to   = req.query.to   || to;
    }

    const sql = `
      SELECT
        shift,
        COUNT(*)                                              AS readings,
        ROUND(AVG(plant_oee)::numeric,2)                     AS avg_oee,
        ROUND(AVG(plant_availability)::numeric,2)            AS avg_availability,
        ROUND(AVG(plant_performance)::numeric,2)             AS avg_performance,
        ROUND(AVG(plant_quality)::numeric,2)                 AS avg_quality,
        MAX(total_good)                                       AS total_good,
        MAX(total_scrap)                                      AS total_scrap,
        MAX(total_stops)                                      AS total_stops,
        ROUND((MAX(em1_kwh)-MIN(em1_kwh)+MAX(em2_kwh)-MIN(em2_kwh)+MAX(em3_kwh)-MIN(em3_kwh)+MAX(em4_kwh)-MIN(em4_kwh)+MAX(em5_kwh)-MIN(em5_kwh))::numeric,1) AS total_kwh
      FROM plant_readings
      WHERE time >= $1 AND time <= $2 AND shift IS NOT NULL
      GROUP BY shift
      ORDER BY shift`;

    const result = await db.query(sql, [from, to]);
    res.json({ ok: true, rows: result.rows });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── POST /api/shifts/save — save shifts to registry ──────────────
app.post('/api/shifts/save', (req, res) => {
  cors(res);
  try {
    const { plant_id, shifts } = req.body;
    const registry = loadRegistry();
    const plant    = registry.plants.find(p => p.plant_id === plant_id);
    if (!plant) return res.status(404).json({ error: 'Plant not found' });
    plant.shifts = shifts;
    saveRegistry(registry);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/report — generate report ───────────────────────────
app.get('/api/report', async (req, res) => {
  try {
    const { from, to, type, format, plant, shift } = req.query;
    const fromDt = from || new Date(Date.now()-86400000).toISOString();
    const toDt   = to   || new Date().toISOString();

    // Parse config (header/footer/columns)
    let config = {};
    try { config = JSON.parse(req.query.config || '{}'); } catch(e) {}

    // Get plant name
    const registry  = loadRegistry();
    const plantObj  = registry.plants.find(p=>p.plant_id===plant);
    const plantName = plantObj?.plant_name || 'All Plants';

    const baseParams = [fromDt, toDt];
    const shiftFilter = shift ? ` AND shift=$3` : '';
    const allParams   = shift ? [fromDt, toDt, shift] : [fromDt, toDt];

    // Full hourly query — all columns for all report types
    const hourlySQL = `
      SELECT time_bucket('1 hour', time, INTERVAL '5 hours 30 minutes') AS bucket,
        MODE() WITHIN GROUP (ORDER BY shift) AS shift,
        ROUND(AVG(plant_oee)::numeric,2)          AS plant_oee,
        ROUND(AVG(plant_availability)::numeric,2) AS plant_availability,
        ROUND(AVG(plant_performance)::numeric,2)  AS plant_performance,
        ROUND(AVG(plant_quality)::numeric,2)      AS plant_quality,
        MAX(total_good) AS total_good, MAX(total_scrap) AS total_scrap, MAX(total_stops) AS total_stops,
        ROUND(AVG(em1_kw)::numeric,2) AS em1_kw,   ROUND(AVG(em1_kwh)::numeric,2) AS em1_kwh,
        ROUND(AVG(em1_pf)::numeric,3) AS em1_pf,   ROUND(AVG(em1_voltage)::numeric,1) AS em1_voltage,
        ROUND(AVG(em2_kw)::numeric,2) AS em2_kw,   ROUND(AVG(em2_kwh)::numeric,2) AS em2_kwh,
        ROUND(AVG(em2_pf)::numeric,3) AS em2_pf,   ROUND(AVG(em2_voltage)::numeric,1) AS em2_voltage,
        ROUND(AVG(em3_kw)::numeric,2) AS em3_kw,   ROUND(AVG(em3_kwh)::numeric,2) AS em3_kwh,
        ROUND(AVG(em3_pf)::numeric,3) AS em3_pf,   ROUND(AVG(em3_voltage)::numeric,1) AS em3_voltage,
        ROUND(AVG(em4_kw)::numeric,2) AS em4_kw,   ROUND(AVG(em4_kwh)::numeric,2) AS em4_kwh,
        ROUND(AVG(em4_pf)::numeric,3) AS em4_pf,   ROUND(AVG(em4_voltage)::numeric,1) AS em4_voltage,
        ROUND(AVG(em5_kw)::numeric,2) AS em5_kw,   ROUND(AVG(em5_kwh)::numeric,2) AS em5_kwh,
        ROUND(AVG(em5_pf)::numeric,3) AS em5_pf,   ROUND(AVG(em5_voltage)::numeric,1) AS em5_voltage,
        ROUND(AVG(w1_flow)::numeric,2) AS w1_flow,  ROUND(AVG(w1_total)::numeric,1) AS w1_total,
        ROUND(AVG(w2_flow)::numeric,2) AS w2_flow,  ROUND(AVG(w2_total)::numeric,1) AS w2_total,
        ROUND(AVG(w3_flow)::numeric,2) AS w3_flow,  ROUND(AVG(w3_total)::numeric,1) AS w3_total,
        ROUND(AVG(w4_flow)::numeric,2) AS w4_flow,  ROUND(AVG(w4_total)::numeric,1) AS w4_total,
        ROUND(AVG(w5_flow)::numeric,2) AS w5_flow,  ROUND(AVG(w5_total)::numeric,1) AS w5_total,
        ROUND(AVG(m1_vib)::numeric,2) AS m1_vib,   ROUND(AVG(m1_temp)::numeric,1) AS m1_temp,
        ROUND(AVG(m1_bearing_temp)::numeric,1) AS m1_bearing_temp,
        ROUND(AVG(m1_current)::numeric,2) AS m1_current, ROUND(AVG(m1_speed)::numeric,0) AS m1_speed,
        ROUND(AVG(m1_coolant_temp)::numeric,1) AS m1_coolant_temp,
        ROUND(AVG(m1_air_pressure)::numeric,2) AS m1_air_pressure,
        MODE() WITHIN GROUP (ORDER BY m1_status) AS m1_status,
        ROUND(AVG(m2_vib)::numeric,2) AS m2_vib,   ROUND(AVG(m2_temp)::numeric,1) AS m2_temp,
        ROUND(AVG(m2_bearing_temp)::numeric,1) AS m2_bearing_temp,
        ROUND(AVG(m2_current)::numeric,2) AS m2_current, ROUND(AVG(m2_speed)::numeric,0) AS m2_speed,
        MODE() WITHIN GROUP (ORDER BY m2_status) AS m2_status,
        ROUND(AVG(m3_vib)::numeric,2) AS m3_vib,   ROUND(AVG(m3_temp)::numeric,1) AS m3_temp,
        ROUND(AVG(m3_bearing_temp)::numeric,1) AS m3_bearing_temp,
        ROUND(AVG(m3_current)::numeric,2) AS m3_current, ROUND(AVG(m3_speed)::numeric,0) AS m3_speed,
        MODE() WITHIN GROUP (ORDER BY m3_status) AS m3_status,
        ROUND(AVG(m4_vib)::numeric,2) AS m4_vib,   ROUND(AVG(m4_temp)::numeric,1) AS m4_temp,
        ROUND(AVG(m4_bearing_temp)::numeric,1) AS m4_bearing_temp,
        ROUND(AVG(m4_current)::numeric,2) AS m4_current, ROUND(AVG(m4_speed)::numeric,0) AS m4_speed,
        MODE() WITHIN GROUP (ORDER BY m4_status) AS m4_status,
        ROUND(AVG(m5_vib)::numeric,2) AS m5_vib,   ROUND(AVG(m5_temp)::numeric,1) AS m5_temp,
        ROUND(AVG(m5_bearing_temp)::numeric,1) AS m5_bearing_temp,
        ROUND(AVG(m5_current)::numeric,2) AS m5_current, ROUND(AVG(m5_speed)::numeric,0) AS m5_speed,
        MODE() WITHIN GROUP (ORDER BY m5_status) AS m5_status
      FROM plant_readings
      WHERE time >= $1 AND time <= $2 ${shiftFilter}
      GROUP BY time_bucket('1 hour', time, INTERVAL '5 hours 30 minutes') ORDER BY bucket ASC`;

    const [hourlyResult, summaryResult, shiftResult] = await Promise.all([
      db.query(hourlySQL, allParams),
      db.query(`SELECT
        ROUND(AVG(plant_oee)::numeric,2) AS avg_oee,
        ROUND(AVG(plant_availability)::numeric,2) AS avg_availability,
        ROUND(AVG(plant_performance)::numeric,2) AS avg_performance,
        ROUND(AVG(plant_quality)::numeric,2) AS avg_quality,
        MAX(total_good) AS total_good, MAX(total_scrap) AS total_scrap,
        MAX(total_stops) AS total_stops,
        ROUND((MAX(em1_kwh)-MIN(em1_kwh)+MAX(em2_kwh)-MIN(em2_kwh)+MAX(em3_kwh)-MIN(em3_kwh)+MAX(em4_kwh)-MIN(em4_kwh)+MAX(em5_kwh)-MIN(em5_kwh))::numeric,1) AS total_kwh,
        ROUND(AVG(w1_flow+w2_flow+w3_flow+w4_flow+w5_flow)::numeric,1) AS avg_water_flow,
        COUNT(*) AS readings
        FROM plant_readings WHERE time >= $1 AND time <= $2`, baseParams),
      db.query(`SELECT shift, COUNT(*) AS readings,
        ROUND(AVG(plant_oee)::numeric,2) AS avg_oee,
        ROUND(AVG(plant_availability)::numeric,2) AS avg_availability,
        ROUND(AVG(plant_performance)::numeric,2) AS avg_performance,
        ROUND(AVG(plant_quality)::numeric,2) AS avg_quality,
        MAX(total_good) AS total_good, MAX(total_scrap) AS total_scrap,
        MAX(total_stops) AS total_stops,
        ROUND((MAX(em1_kwh)-MIN(em1_kwh)+MAX(em2_kwh)-MIN(em2_kwh)+MAX(em3_kwh)-MIN(em3_kwh)+MAX(em4_kwh)-MIN(em4_kwh)+MAX(em5_kwh)-MIN(em5_kwh))::numeric,1) AS total_kwh
        FROM plant_readings WHERE time >= $1 AND time <= $2 AND shift IS NOT NULL
        GROUP BY shift ORDER BY shift`, baseParams),
    ]);

    const payload = {
      rows:      hourlyResult.rows,
      shiftRows: shiftResult.rows,
      summary:   summaryResult.rows[0] || {},
      meta:      { type: type||'oee', from: fromDt, to: toDt, plant_name: plantName },
      config,
    };

    if (format === 'excel') {
      const buffer = await buildExcel(payload);
      const fname  = `oee_${type||'report'}_${new Date().toISOString().slice(0,10)}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      return res.send(buffer);
    }

    // HTML (default / PDF / preview)
    const html = buildHTML(payload);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);

  } catch (e) {
    console.error('[Report] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /plants ─── serve plant manager page (auth required) ─────
app.get('/plants', pageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'plants.html'));
});

// ── GET /widgets ─── serve widget library page (auth required) ───
app.get('/widgets', pageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'widgets.html'));
});

// ── GET /device-setup override ─── auth required ─────────────────
app.get('/device-setup', pageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'device-setup.html'));
});

// ══════════════════════════════════════════════════════════════════
//  KPI CONFIG API
// ══════════════════════════════════════════════════════════════════
const KPI_PATH = path.join(__dirname, 'config', 'kpi_config.json');

function loadKPIs() {
  try { return JSON.parse(fs.readFileSync(KPI_PATH, 'utf8')); }
  catch { return { kpis: [] }; }
}
function saveKPIs(store) {
  fs.writeFileSync(KPI_PATH, JSON.stringify(store, null, 2));
}

// GET /api/kpi — list all saved KPIs
app.get('/api/kpi', (req, res) => {
  cors(res);
  try {
    const store = loadKPIs();
    const plantFilter = req.query.plant;
    const kpis = plantFilter
      ? store.kpis.filter(k => k.plant_id === plantFilter)
      : store.kpis;
    res.json({ ok: true, count: kpis.length, kpis });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/kpi — create or update a KPI
app.post('/api/kpi', (req, res) => {
  cors(res);
  try {
    const kpi   = req.body;
    if (!kpi.id || !kpi.name || !kpi.plant_id || !kpi.widget_type) {
      return res.status(400).json({ error: 'id, name, plant_id and widget_type are required' });
    }
    const store = loadKPIs();
    const idx   = store.kpis.findIndex(k => k.id === kpi.id);
    if (idx >= 0) store.kpis[idx] = kpi;
    else store.kpis.push(kpi);
    saveKPIs(store);
    console.log(`[KPI] ✅ Saved: ${kpi.id}`);
    res.json({ ok: true, kpi });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/kpi/:id — remove a KPI
app.delete('/api/kpi/:id', (req, res) => {
  cors(res);
  try {
    const store = loadKPIs();
    const idx   = store.kpis.findIndex(k => k.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'KPI not found' });
    store.kpis.splice(idx, 1);
    saveKPIs(store);
    res.json({ ok: true, deleted: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  ALERTS & NOTIFICATIONS API
// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════
//  Facto-Bot AGENT — CHAT API
// ══════════════════════════════════════════════════════════════════
app.post('/api/chat', aiLimiter, async (req, res) => {
  cors(res);
  try {
    const { question, mode } = req.body;
    if (!question?.trim()) return res.status(400).json({ error:'Question required' });
    const q = question.trim();
    const m = (mode || 'chat').toLowerCase(); // chat | report | chart | rca

    // ── 1. AI (Gemini FREE first, then Claude paid) ──────────
    const _gKey = process.env.GEMINI_API_KEY;
    const _cKey = process.env.ANTHROPIC_API_KEY;
    if ((_gKey && _gKey.length > 10) || _cKey?.startsWith('sk-ant-')) {
      try { return res.json(await aiAnswer(q, db, { geminiKey: _gKey||null, anthropicKey: _cKey||null })); }
      catch(e) { console.warn('[Facto-Bot] AI fallback:', e.message); }
    }

    // ── 2. Free AI (Groq / Gemini / Ollama) — mode-aware ────
    try {
      const aiResult = await freeAIAnswer(q, db, m);
      if (aiResult) return res.json(aiResult);
    } catch(e) { console.warn('[Facto-Bot] Free AI fallback:', e.message); }

    // ── 3. CNC rule-based fallback ───────────────────────────
    const result = await cncAnswer(q, db);
    res.json({ ...result, engine: result.engine || 'cnc-fallback', mode: m });

  } catch(e) {
    res.status(500).json({ ok:false, text:'Agent error: '+e.message });
  }
});

// GET /api/chat/engine — which engine is active
app.get('/api/chat/engine', (req, res) => {
  cors(res);
  const info = detectEngine();
  res.json({ ok:true, ...info });
});

app.get('/api/chat/suggestions', (req, res) => { cors(res); res.json({ ok:true, suggestions:SUGGESTIONS }); });

// Serve alerts page
app.get('/alerts', pageAuth, (req,res)=>res.sendFile(path.join(__dirname,'public','alerts.html')));

// GET /api/alerts/rules
app.get('/api/alerts/rules', (req,res)=>{ cors(res); const {rules,schedules,config}=loadAlertRules(); res.json({ok:true,rules,schedules,config}); });

// POST /api/alerts/rules — save new rule
app.post('/api/alerts/rules', (req,res)=>{
  cors(res);
  try {
    const store=loadAlertStore(); store.rules=store.rules||[];
    const idx=store.rules.findIndex(r=>r.id===req.body.id);
    if(idx>=0) store.rules[idx]=req.body; else store.rules.push(req.body);
    saveAlertStore(store); res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// DELETE /api/alerts/rules/:id
app.delete('/api/alerts/rules/:id', (req,res)=>{
  cors(res);
  const store=loadAlertStore(); store.rules=(store.rules||[]).filter(r=>r.id!==req.params.id);
  saveAlertStore(store); res.json({ok:true});
});

// PATCH /api/alerts/rules/:id/toggle
app.patch('/api/alerts/rules/:id/toggle', (req,res)=>{
  cors(res);
  const store=loadAlertStore(); const rule=(store.rules||[]).find(r=>r.id===req.params.id);
  if(!rule) return res.status(404).json({error:'Not found'});
  rule.active=!rule.active; saveAlertStore(store); res.json({ok:true,active:rule.active});
});

// GET /api/alerts/schedules
app.get('/api/alerts/schedules', (req,res)=>{ cors(res); const s=loadAlertStore(); res.json({ok:true,schedules:s.schedules||[]}); });

// POST /api/alerts/schedules
app.post('/api/alerts/schedules', (req,res)=>{
  cors(res);
  try {
    const store=loadAlertStore(); store.schedules=store.schedules||[];
    const idx=store.schedules.findIndex(s=>s.id===req.body.id);
    if(idx>=0) store.schedules[idx]=req.body; else store.schedules.push(req.body);
    saveAlertStore(store); res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// DELETE /api/alerts/schedules/:id
app.delete('/api/alerts/schedules/:id', (req,res)=>{
  cors(res);
  const store=loadAlertStore(); store.schedules=(store.schedules||[]).filter(s=>s.id!==req.params.id);
  saveAlertStore(store); res.json({ok:true});
});

// PATCH /api/alerts/schedules/:id/toggle
app.patch('/api/alerts/schedules/:id/toggle', (req,res)=>{
  cors(res);
  const store=loadAlertStore(); const sched=(store.schedules||[]).find(s=>s.id===req.params.id);
  if(!sched) return res.status(404).json({error:'Not found'});
  sched.active=!sched.active; saveAlertStore(store); res.json({ok:true,active:sched.active});
});

// POST /api/alerts/schedules/:id/run — run immediately
app.post('/api/alerts/schedules/:id/run', async (req,res)=>{
  cors(res);
  const store=loadAlertStore(); const sched=(store.schedules||[]).find(s=>s.id===req.params.id);
  if(!sched) return res.status(404).json({error:'Not found'});
  try {
    await alertEngine.runScheduledReport(sched, null, {smtp:store.smtp,whatsapp:store.whatsapp});
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// GET /api/alerts/config
app.get('/api/alerts/config', (req,res)=>{ cors(res); const s=loadAlertStore(); res.json({ok:true,config:{smtp:s.smtp||{},whatsapp:s.whatsapp||{}}}); });

// POST /api/alerts/config/smtp
// Normalises field aliases: username→user, password→pass, recipients ignored here
app.post('/api/alerts/config/smtp', (req,res)=>{
  cors(res);
  const b = req.body;
  const normalised = {
    host:       b.host       || b.smtp_host   || '',
    port:       parseInt(b.port || b.smtp_port || 587),
    secure:     b.port === 465 || b.secure || false,
    user:       b.user       || b.username    || b.email || '',
    pass:       b.pass       || b.password    || b.smtp_pass || '',
    from_name:  b.from_name  || b.fromName    || 'Factory-MIOS Platform',
    from_email: b.from_email || b.fromEmail   || b.user || b.username || b.email || '',
  };
  const store = loadAlertStore();
  store.smtp  = { ...store.smtp, ...normalised };
  saveAlertStore(store);
  res.json({ ok: true, saved: { host: normalised.host, user: normalised.user, port: normalised.port } });
});

// POST /api/alerts/config/whatsapp
app.post('/api/alerts/config/whatsapp', (req,res)=>{
  cors(res);
  const store=loadAlertStore(); store.whatsapp={...store.whatsapp,...req.body};
  saveAlertStore(store); res.json({ok:true});
});

// POST /api/alerts/test-email
app.post('/api/alerts/test-email', async (req,res)=>{
  cors(res);
  try {
    const store=loadAlertStore();
    if(!store.smtp?.host) return res.status(400).json({error:'SMTP not configured yet'});
    const {sendTestEmail}=require('./lib/mailer');
    await sendTestEmail({smtp:store.smtp, to:req.body.to||store.smtp.user});
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// POST /api/alerts/test-whatsapp
app.post('/api/alerts/test-whatsapp', async (req,res)=>{
  cors(res);
  try {
    const store=loadAlertStore();
    const {sendWhatsApp}=require('./lib/whatsapp');
    await sendWhatsApp({config:store.whatsapp, phones:[req.body.phone], message:'✅ Factory-MIOS — WhatsApp test successful!\n\nYour alerts are configured correctly.\n\nTime: '+new Date().toLocaleString('en-IN')});
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// POST /api/alerts/test/:id — test fire a specific rule
app.post('/api/alerts/test/:id', async (req,res)=>{
  cors(res);
  try {
    const store=loadAlertStore(); const rule=(store.rules||[]).find(r=>r.id===req.params.id);
    if(!rule) return res.status(404).json({error:'Rule not found'});
    const fakeData={PLANT_OEE:65,PLANT_AVAILABILITY:80,PLANT_PERFORMANCE:85,PLANT_QUALITY:90,SHIFT:'SHIFT_A'};
    const {sendAlertEmail}=require('./lib/mailer');
    const {sendWhatsApp,formatAlertMessage}=require('./lib/whatsapp');
    if(rule.delivery?.includes('email')&&rule.emails?.length&&store.smtp?.host){
      await sendAlertEmail({smtp:store.smtp,to:rule.emails,rule,value:'[TEST] '+rule.threshold,liveData:fakeData});
    }
    if(rule.delivery?.includes('whatsapp')&&rule.phones?.length&&store.whatsapp?.callmebot_apikey){
      const msg='🧪 *TEST ALERT* — '+rule.name+'\n\nThis is a test notification from Factory-MIOS.';
      await sendWhatsApp({config:store.whatsapp,phones:rule.phones,message:msg});
    }
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// GET /api/alerts/history
app.get('/api/alerts/history', (req,res)=>{
  cors(res);
  try { const h=alertEngine.loadHistory(); res.json({ok:true,history:h}); }
  catch { res.json({ok:true,history:[]}); }
});

// DELETE /api/alerts/history
app.delete('/api/alerts/history', (req,res)=>{
  cors(res);
  alertEngine.saveHistory([]); res.json({ok:true});
});

// ══════════════════════════════════════════════════════════════════
//  SHIFT LOG API — Targets, Downtime, Defects
// ══════════════════════════════════════════════════════════════════

// Helper: auto-create tables if they don't exist yet
async function ensureShiftLogTables() {
  const sql = `
    CREATE TABLE IF NOT EXISTS shift_targets (
      id SERIAL PRIMARY KEY, plant_id TEXT NOT NULL DEFAULT 'plant_1',
      shift_date DATE NOT NULL, shift TEXT NOT NULL, operator_name TEXT NOT NULL,
      target_production INTEGER, ideal_cycle_sec NUMERIC(8,2), planned_production INTEGER,
      actual_production INTEGER, notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (plant_id, shift_date, shift)
    );
    CREATE TABLE IF NOT EXISTS downtime_events (
      id SERIAL PRIMARY KEY, plant_id TEXT NOT NULL DEFAULT 'plant_1',
      shift_date DATE NOT NULL, shift TEXT NOT NULL, operator_name TEXT NOT NULL,
      start_time TIMESTAMPTZ, end_time TIMESTAMPTZ,
      duration_min NUMERIC(8,2) NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('MINOR','MAJOR')),
      reason_code TEXT NOT NULL, reason_detail TEXT, machine_id TEXT,
      logged_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_downtime_shift ON downtime_events (plant_id, shift_date, shift);
    CREATE TABLE IF NOT EXISTS defect_events (
      id SERIAL PRIMARY KEY, plant_id TEXT NOT NULL DEFAULT 'plant_1',
      shift_date DATE NOT NULL, shift TEXT NOT NULL, operator_name TEXT NOT NULL,
      defect_count INTEGER NOT NULL, defect_type TEXT NOT NULL, defect_reason TEXT,
      line_id TEXT, machine_id TEXT,
      logged_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_defect_shift ON defect_events (plant_id, shift_date, shift);
  `;
  const client = await db.connect();
  try { await client.query(sql); }
  catch(e) { console.warn('[ShiftLog] Table init:', e.message); }
  finally { client.release(); }
}
ensureShiftLogTables();

// ── SaaS Platform Tables ───────────────────────────────────────────
async function ensureSaasTables() {
  const sql = `
    CREATE TABLE IF NOT EXISTS tenants (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
      industry TEXT, contact_email TEXT, plan TEXT DEFAULT 'basic',
      status TEXT DEFAULT 'active', max_plants INT DEFAULT 5, max_users INT DEFAULT 10,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS saas_plants (
      id SERIAL PRIMARY KEY, tenant_id INT REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL, code TEXT NOT NULL, location TEXT,
      timezone TEXT DEFAULT 'Asia/Kolkata', status TEXT DEFAULT 'active',
      auto_dashboard BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS saas_machines (
      id SERIAL PRIMARY KEY, plant_id INT REFERENCES saas_plants(id) ON DELETE CASCADE,
      machine_id TEXT NOT NULL, name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'CNC', make TEXT, model TEXT, protocol TEXT,
      host TEXT, port INT, data_source TEXT DEFAULT 'manual',
      description TEXT, status TEXT DEFAULT 'active',
      isa95_config JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS saas_audit_log (
      id BIGSERIAL PRIMARY KEY, action TEXT, entity TEXT, entity_id TEXT,
      user_id TEXT, details TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Per-tenant page visibility (superadmin can toggle)
    CREATE TABLE IF NOT EXISTS tenant_page_permissions (
      id SERIAL PRIMARY KEY,
      tenant_id INT REFERENCES tenants(id) ON DELETE CASCADE,
      page_key TEXT NOT NULL,
      page_label TEXT,
      enabled BOOLEAN DEFAULT true,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, page_key)
    );
    -- Per-tenant KPI visibility
    CREATE TABLE IF NOT EXISTS tenant_kpi_permissions (
      id SERIAL PRIMARY KEY,
      tenant_id INT REFERENCES tenants(id) ON DELETE CASCADE,
      kpi_key TEXT NOT NULL,
      kpi_label TEXT,
      enabled BOOLEAN DEFAULT true,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, kpi_key)
    );
    -- Seed-flag table: each key records a one-time migration / seed that must never repeat.
    -- Once set, deleting a plant or machine from the UI will NOT bring it back on restart.
    CREATE TABLE IF NOT EXISTS saas_seed_flags (
      key TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    );
  `;
  const client = await db.connect();
  try {
    await client.query(sql);

    // ── Tenant seed (idempotent — tenant is never user-deletable from UI) ──────
    await client.query(`
      INSERT INTO tenants(id, name, slug, industry, contact_email, plan, max_plants, max_users)
      VALUES(1, 'Factory-MIOS Demo', 'factory-mios-demo', 'Automotive', 'admin@factory-mios.local', 'pro', 10, 50)
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, slug=EXCLUDED.slug, plan=EXCLUDED.plan
    `);
    await client.query(`SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), 1))`);

    // ── One-time plant/machine seed ────────────────────────────────────────────
    // Uses a flag so once set it NEVER re-inserts — deletions from the UI are permanent.
    // On an existing install the flag is set immediately without touching current data.
    const { rows: sf } = await client.query(`SELECT 1 FROM saas_seed_flags WHERE key='initial_demo-factory_v1'`);
    if (!sf.length) {
      // Mark applied NOW so even if the insert below is skipped (data exists) we don't repeat
      await client.query(`INSERT INTO saas_seed_flags(key) VALUES('initial_demo-factory_v1') ON CONFLICT DO NOTHING`);
      // Only seed if tables are empty (truly fresh install)
      const { rows: pc } = await client.query('SELECT COUNT(*) AS cnt FROM saas_plants');
      if (parseInt(pc[0].cnt) === 0) {
        await client.query(`
          INSERT INTO saas_plants(id, tenant_id, name, code, location, timezone)
          VALUES(1, 1, 'Demo Plant', 'DEMO', 'Factory Site', 'Asia/Kolkata')
          ON CONFLICT(id) DO NOTHING
        `);
        await client.query(`SELECT setval('saas_plants_id_seq', GREATEST((SELECT MAX(id) FROM saas_plants), 1))`);
        await client.query(`
          INSERT INTO saas_machines(id, plant_id, machine_id, name, type, make, model, protocol, data_source)
          VALUES(1, 1, 'MACHINE001', 'Demo Production Machine', 'CNC', 'Demo Machine', 'M-896', 'Industrial CNC-FOCAS', 'mqtt')
          ON CONFLICT(id) DO NOTHING
        `);
        await client.query(`SELECT setval('saas_machines_id_seq', GREATEST((SELECT MAX(id) FROM saas_machines), 1))`);
        console.log('[SaaS] 🌱 Initial seed: Demo Plant + MACHINE001 created');
      } else {
        console.log('[SaaS] 🏷️  Seed flag set on existing data — no re-seed');
      }
    }

    // Seed default page permissions for Factory-MIOS Demo (all pages)
    const DEFAULT_PAGES = [
      { key:'dashboard',         label:'OEE Dashboard' },
      { key:'machine-live',      label:'Machine Live' },
      { key:'manager',           label:'Manager View' },
      { key:'predictive',        label:'Predictive Maintenance' },
      { key:'downtime-analysis', label:'Downtime Analysis' },
      { key:'quality-entry',     label:'Quality Entry' },
      { key:'master-data',       label:'Master Data' },
      { key:'reports',           label:'Reports' },
      { key:'shift-log',         label:'Shift Log' },
      { key:'downtime-log',      label:'Downtime Log' },
      { key:'chat',              label:'AI Chat' },
      { key:'operator',          label:'Operator View' },
      { key:'supervisor',        label:'Supervisor View' },
      { key:'digital-twin',      label:'Digital Twin' },
      { key:'connectivity',      label:'Network / Connectivity' },
      { key:'alerts',            label:'Alerts & Rules' },
      { key:'builder',           label:'Dashboard Builder' },
      { key:'my-dashboards',     label:'My Dashboards' },
      { key:'users',             label:'User Management' },
      { key:'saas-platform',     label:'Platform Admin' },
      { key:'super-admin',       label:'Super Admin' },
    ];
    for (const p of DEFAULT_PAGES) {
      await client.query(`
        INSERT INTO tenant_page_permissions(tenant_id, page_key, page_label, enabled)
        VALUES(1, $1, $2, true) ON CONFLICT(tenant_id, page_key) DO NOTHING
      `, [p.key, p.label]);
    }

    // Seed default KPI permissions for Factory-MIOS Demo
    const DEFAULT_KPIS = [
      { key:'oee',          label:'OEE %' },
      { key:'availability', label:'Availability %' },
      { key:'performance',  label:'Performance %' },
      { key:'quality',      label:'Quality %' },
      { key:'parts',        label:'Parts Produced' },
      { key:'downtime',     label:'Downtime Chart' },
      { key:'cycle_time',   label:'Cycle Time' },
      { key:'alarms',       label:'Alarm Count' },
      { key:'spindle',      label:'Spindle Speed' },
      { key:'feed_rate',    label:'Feed Rate' },
    ];
    for (const k of DEFAULT_KPIS) {
      await client.query(`
        INSERT INTO tenant_kpi_permissions(tenant_id, kpi_key, kpi_label, enabled)
        VALUES(1, $1, $2, true) ON CONFLICT(tenant_id, kpi_key) DO NOTHING
      `, [k.key, k.label]);
    }

    // ── Migrate existing tables — add columns if missing ────────────
    const alterCols = [
      `ALTER TABLE saas_machines ADD COLUMN IF NOT EXISTS make         TEXT`,
      `ALTER TABLE saas_machines ADD COLUMN IF NOT EXISTS model        TEXT`,
      `ALTER TABLE saas_machines ADD COLUMN IF NOT EXISTS isa95_config JSONB`,
      `ALTER TABLE saas_audit_log ADD COLUMN IF NOT EXISTS user_id     TEXT`,
      `ALTER TABLE saas_plants    ADD COLUMN IF NOT EXISTS auto_dashboard BOOLEAN DEFAULT true`,
    ];
    for (const stmt of alterCols) {
      try { await client.query(stmt); }
      catch(e) { /* column may already exist */ }
    }

    console.log('[SaaS] ✅ Tables ready + Factory-MIOS Demo seeded');
  }
  catch(e) { console.warn('[SaaS] Table init:', e.message); }
  finally { client.release(); }
}
ensureSaasTables();

// ── Shift Targets ─────────────────────────────────────────────────

// GET /api/shift-targets — list (filter by date, shift, from/to, plant)
app.get('/api/shift-targets', authMiddleware, async (req, res) => {
  cors(res);
  try {
    const { date, shift, from, to, plant } = req.query;
    const cond = [], params = [];
    if (date)  { params.push(date);  cond.push(`shift_date = $${params.length}`); }
    if (from)  { params.push(from);  cond.push(`shift_date >= $${params.length}`); }
    if (to)    { params.push(to);    cond.push(`shift_date <= $${params.length}`); }
    if (shift) { params.push(shift); cond.push(`shift = $${params.length}`); }
    if (plant) { params.push(plant); cond.push(`plant_id = $${params.length}`); }
    const where = cond.length ? 'WHERE '+cond.join(' AND ') : '';
    const r = await db.query(`SELECT * FROM shift_targets ${where} ORDER BY shift_date DESC, shift`, params);
    res.json({ ok: true, targets: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/shift-targets/:id
app.get('/api/shift-targets/:id', authMiddleware, async (req, res) => {
  cors(res);
  try {
    const r = await db.query('SELECT * FROM shift_targets WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, target: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/shift-targets — upsert (one per plant/date/shift)
app.post('/api/shift-targets', authMiddleware, async (req, res) => {
  cors(res);
  try {
    const { plant_id='plant_1', shift_date, shift, operator_name,
            target_production, ideal_cycle_sec, planned_production, notes } = req.body;
    if (!shift_date || !shift || !operator_name) return res.status(400).json({ error: 'shift_date, shift, operator_name required' });
    const sql = `
      INSERT INTO shift_targets (plant_id, shift_date, shift, operator_name,
        target_production, ideal_cycle_sec, planned_production, notes, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      ON CONFLICT (plant_id, shift_date, shift)
      DO UPDATE SET operator_name=$4, target_production=$5, ideal_cycle_sec=$6,
                    planned_production=$7, notes=$8, updated_at=NOW()
      RETURNING *`;
    const r = await db.query(sql, [plant_id, shift_date, shift, operator_name,
                                    target_production||null, ideal_cycle_sec||null,
                                    planned_production||null, notes||null]);
    res.json({ ok: true, target: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/shift-targets/:id
app.put('/api/shift-targets/:id', authMiddleware, async (req, res) => {
  cors(res);
  try {
    const { operator_name, target_production, ideal_cycle_sec, planned_production, notes } = req.body;
    const r = await db.query(
      `UPDATE shift_targets SET operator_name=COALESCE($1,operator_name),
         target_production=COALESCE($2,target_production),
         ideal_cycle_sec=COALESCE($3,ideal_cycle_sec),
         planned_production=COALESCE($4,planned_production),
         notes=COALESCE($5,notes), updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [operator_name||null, target_production||null, ideal_cycle_sec||null,
       planned_production||null, notes||null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, target: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/shift-targets/:id
app.delete('/api/shift-targets/:id', authMiddleware, async (req, res) => {
  cors(res);
  try {
    await db.query('DELETE FROM shift_targets WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Downtime Events ───────────────────────────────────────────────

// GET /api/downtime
app.get('/api/downtime', authMiddleware, async (req, res) => {
  cors(res);
  try {
    const { date, shift, from, to, category, plant } = req.query;
    const cond = [], params = [];
    if (date)     { params.push(date);     cond.push(`shift_date = $${params.length}`); }
    if (from)     { params.push(from);     cond.push(`shift_date >= $${params.length}`); }
    if (to)       { params.push(to);       cond.push(`shift_date <= $${params.length}`); }
    if (shift)    { params.push(shift);    cond.push(`shift = $${params.length}`); }
    if (category) { params.push(category); cond.push(`category = $${params.length}`); }
    if (plant)    { params.push(plant);    cond.push(`plant_id = $${params.length}`); }
    const where = cond.length ? 'WHERE '+cond.join(' AND ') : '';
    const r = await db.query(`SELECT * FROM downtime_events ${where} ORDER BY shift_date DESC, logged_at DESC`, params);
    res.json({ ok: true, events: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/downtime/:id
app.get('/api/downtime/:id', authMiddleware, async (req, res) => {
  cors(res);
  try {
    const r = await db.query('SELECT * FROM downtime_events WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, event: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/downtime
app.post('/api/downtime', authMiddleware, async (req, res) => {
  cors(res);
  try {
    const { plant_id='plant_1', shift_date, shift, operator_name,
            start_time, end_time, duration_min, category, reason_code, reason_detail, machine_id } = req.body;
    if (!shift_date||!shift||!operator_name||!duration_min||!category||!reason_code)
      return res.status(400).json({ error: 'shift_date, shift, operator_name, duration_min, category, reason_code required' });
    const r = await db.query(
      `INSERT INTO downtime_events (plant_id, shift_date, shift, operator_name,
         start_time, end_time, duration_min, category, reason_code, reason_detail, machine_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [plant_id, shift_date, shift, operator_name,
       start_time||null, end_time||null, duration_min, category, reason_code,
       reason_detail||null, machine_id||null]
    );
    res.json({ ok: true, event: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/downtime/:id
app.put('/api/downtime/:id', authMiddleware, async (req, res) => {
  cors(res);
  try {
    const { operator_name, duration_min, category, reason_code, reason_detail, machine_id } = req.body;
    const r = await db.query(
      `UPDATE downtime_events SET
         operator_name=COALESCE($1,operator_name),
         duration_min=COALESCE($2,duration_min),
         category=COALESCE($3,category),
         reason_code=COALESCE($4,reason_code),
         reason_detail=COALESCE($5,reason_detail),
         machine_id=COALESCE($6,machine_id),
         updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [operator_name||null, duration_min||null, category||null,
       reason_code||null, reason_detail||null, machine_id||null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, event: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/downtime/:id
app.delete('/api/downtime/:id', authMiddleware, async (req, res) => {
  cors(res);
  try {
    await db.query('DELETE FROM downtime_events WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Defect Events ─────────────────────────────────────────────────

// GET /api/defects
app.get('/api/defects', authMiddleware, async (req, res) => {
  cors(res);
  try {
    const { date, shift, from, to, plant } = req.query;
    const cond = [], params = [];
    if (date)  { params.push(date);  cond.push(`shift_date = $${params.length}`); }
    if (from)  { params.push(from);  cond.push(`shift_date >= $${params.length}`); }
    if (to)    { params.push(to);    cond.push(`shift_date <= $${params.length}`); }
    if (shift) { params.push(shift); cond.push(`shift = $${params.length}`); }
    if (plant) { params.push(plant); cond.push(`plant_id = $${params.length}`); }
    const where = cond.length ? 'WHERE '+cond.join(' AND ') : '';
    const r = await db.query(`SELECT * FROM defect_events ${where} ORDER BY shift_date DESC, logged_at DESC`, params);
    res.json({ ok: true, events: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/defects/:id
app.get('/api/defects/:id', authMiddleware, async (req, res) => {
  cors(res);
  try {
    const r = await db.query('SELECT * FROM defect_events WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, event: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/defects
app.post('/api/defects', authMiddleware, async (req, res) => {
  cors(res);
  try {
    const { plant_id='plant_1', shift_date, shift, operator_name,
            defect_count, defect_type, defect_reason, line_id, machine_id } = req.body;
    if (!shift_date||!shift||!operator_name||!defect_count||!defect_type||!defect_reason)
      return res.status(400).json({ error: 'shift_date, shift, operator_name, defect_count, defect_type, defect_reason required' });
    const r = await db.query(
      `INSERT INTO defect_events (plant_id, shift_date, shift, operator_name,
         defect_count, defect_type, defect_reason, line_id, machine_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [plant_id, shift_date, shift, operator_name,
       defect_count, defect_type, defect_reason, line_id||null, machine_id||null]
    );
    res.json({ ok: true, event: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/defects/:id
app.put('/api/defects/:id', authMiddleware, async (req, res) => {
  cors(res);
  try {
    const { operator_name, defect_count, defect_type, defect_reason, machine_id } = req.body;
    const r = await db.query(
      `UPDATE defect_events SET
         operator_name=COALESCE($1,operator_name),
         defect_count=COALESCE($2,defect_count),
         defect_type=COALESCE($3,defect_type),
         defect_reason=COALESCE($4,defect_reason),
         machine_id=COALESCE($5,machine_id),
         updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [operator_name||null, defect_count||null, defect_type||null,
       defect_reason||null, machine_id||null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, event: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/defects/:id
app.delete('/api/defects/:id', authMiddleware, async (req, res) => {
  cors(res);
  try {
    await db.query('DELETE FROM defect_events WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/shift-log/report — combined summary for reports page
app.get('/api/shift-log/report', authMiddleware, async (req, res) => {
  cors(res);
  try {
    const { from, to, shift, plant } = req.query;
    const fromDate = from || new Date(Date.now()-7*86400000).toISOString().slice(0,10);
    const toDate   = to   || new Date().toISOString().slice(0,10);

    const dtSql = `
      SELECT shift_date, shift, SUM(duration_min) AS total_downtime_min,
             COUNT(*) AS total_events,
             SUM(CASE WHEN category='MAJOR' THEN 1 ELSE 0 END) AS major_events,
             SUM(CASE WHEN category='MINOR' THEN 1 ELSE 0 END) AS minor_events,
             MODE() WITHIN GROUP (ORDER BY reason_code) AS top_reason
      FROM downtime_events
      WHERE shift_date>=$1 AND shift_date<=$2
        ${shift ? "AND shift=$3" : ""}
      GROUP BY shift_date, shift ORDER BY shift_date DESC, shift`;

    const dfSql = `
      SELECT shift_date, shift, SUM(defect_count) AS total_defects,
             COUNT(*) AS log_entries,
             MODE() WITHIN GROUP (ORDER BY defect_type) AS top_defect_type
      FROM defect_events
      WHERE shift_date>=$1 AND shift_date<=$2
        ${shift ? "AND shift=$3" : ""}
      GROUP BY shift_date, shift ORDER BY shift_date DESC, shift`;

    const tgSql = `SELECT * FROM shift_targets
      WHERE shift_date>=$1 AND shift_date<=$2
        ${shift ? "AND shift=$3" : ""}
      ORDER BY shift_date DESC, shift`;

    const p = shift ? [fromDate, toDate, shift] : [fromDate, toDate];
    const [dt, df, tg] = await Promise.all([
      db.query(dtSql, p), db.query(dfSql, p), db.query(tgSql, p)
    ]);
    res.json({ ok: true, downtime: dt.rows, defects: df.rows, targets: tg.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CNC Predictive Health Analysis (real DB data) ────────────────
// GET /api/cnc/predict?machine=MACHINE001&hours=24
app.get('/api/cnc/predict', async (req, res) => {
  cors(res);
  try {
    const machine = req.query.machine || 'MACHINE001';
    const hours   = parseInt(req.query.hours) || 24;

    // 1. Current machine state
    const liveR = await dbCNC.query(
      `SELECT time, machine_state, is_running, spindle_speed, feed_rate,
              raw_cycle_time_sec, last_cycle_time_sec, part_count, alarm_active, alarm_no, program_no
       FROM cnc_data WHERE machine_id=$1 ORDER BY time DESC LIMIT 1`, [machine]);
    const live = liveR.rows[0] || null;

    // 2. Cycle time stats (last N hours, exclude outliers)
    const cycleR = await dbCNC.query(
      `SELECT
         ROUND(AVG(last_cycle_time_sec)::numeric,1) AS avg_cycle,
         ROUND(MIN(last_cycle_time_sec)::numeric,1) AS min_cycle,
         ROUND(MAX(last_cycle_time_sec)::numeric,1) AS max_cycle,
         ROUND(STDDEV(last_cycle_time_sec)::numeric,2) AS stddev_cycle,
         COUNT(*) AS cycle_count
       FROM cnc_data
       WHERE machine_id=$1
         AND last_cycle_time_sec BETWEEN 5 AND 300
         AND time >= NOW() - INTERVAL '${hours} hours'`, [machine]);
    const cycle = cycleR.rows[0] || {};

    // 3. Alarm frequency
    const alarmR = await dbCNC.query(
      `SELECT alarm_no, COUNT(*) AS cnt,
              MIN(time AT TIME ZONE 'Asia/Kolkata') AS first_at,
              MAX(time AT TIME ZONE 'Asia/Kolkata') AS last_at
       FROM cnc_data
       WHERE machine_id=$1 AND alarm_active=true
         AND time >= NOW() - INTERVAL '${hours} hours'
       GROUP BY alarm_no ORDER BY cnt DESC LIMIT 10`, [machine]);
    const alarms = alarmR.rows;
    const totalAlarms = alarms.reduce((s,r) => s + parseInt(r.cnt), 0);

    // 4. Availability (is_running ratio)
    const availR = await dbCNC.query(
      `SELECT
         COUNT(*) FILTER (WHERE is_running) AS running_ticks,
         COUNT(*) AS total_ticks
       FROM cnc_data
       WHERE machine_id=$1 AND time >= NOW() - INTERVAL '${hours} hours'`, [machine]);
    const avail = availR.rows[0] || {};
    const availability = avail.total_ticks > 0
      ? Math.round((parseInt(avail.running_ticks) / parseInt(avail.total_ticks)) * 100)
      : null;

    // 5. 7-day OEE trend
    const trendR = await dbCNC.query(
      `SELECT shift_date::text AS date, shift,
         ROUND(oee::numeric,1) AS oee,
         ROUND(availability::numeric,1) AS availability,
         ROUND(performance::numeric,1) AS performance,
         ROUND(quality::numeric,1) AS quality,
         parts_produced, alarm_count, downtime_min
       FROM oee_results
       WHERE machine_id=$1 AND shift_date >= CURRENT_DATE - INTERVAL '7 days'
       ORDER BY shift_date ASC, shift ASC`, [machine]);
    const trend = trendR.rows;

    // 6. Hourly cycle time trend (last 24h)
    const ctTrendR = await dbCNC.query(
      `SELECT
         DATE_TRUNC('hour', time AT TIME ZONE 'Asia/Kolkata') AS hour_ist,
         ROUND(AVG(last_cycle_time_sec)::numeric,1) AS avg_cycle,
         COUNT(*) AS count
       FROM cnc_data
       WHERE machine_id=$1
         AND last_cycle_time_sec BETWEEN 5 AND 300
         AND time >= NOW() - INTERVAL '24 hours'
       GROUP BY 1 ORDER BY 1`, [machine]);
    const ctTrend = ctTrendR.rows;

    // 7. Alarm trend (daily, last 14 days)
    const alarmTrendR = await dbCNC.query(
      `SELECT (time AT TIME ZONE 'Asia/Kolkata')::date AS day,
              COUNT(*) AS alarm_count
       FROM cnc_data
       WHERE machine_id=$1 AND alarm_active=true
         AND time >= NOW() - INTERVAL '14 days'
       GROUP BY 1 ORDER BY 1`, [machine]);
    const alarmTrend = alarmTrendR.rows;

    // 8. Health scoring — look up ideal cycle from current program
    let idealCycle = 45;
    if (live && live.program_no != null) {
      try {
        const progR = await dbCNC.query(
          `SELECT target_cycle_sec FROM program_master
           WHERE machine_id = $1
             AND program_no = NULLIF(REGEXP_REPLACE($2::TEXT, '[^0-9]', '', 'g'), '')::INT
             AND target_cycle_sec IS NOT NULL
           LIMIT 1`,
          [machine, String(live.program_no)]
        );
        if (progR.rows[0]) idealCycle = parseFloat(progR.rows[0].target_cycle_sec);
      } catch(_) {}
    }
    const cycleDev = cycle.avg_cycle && idealCycle > 0
      ? Math.abs((parseFloat(cycle.avg_cycle) - idealCycle) / idealCycle * 100)
      : 0;
    const cycleHealth = Math.max(0, 100 - cycleDev * 2);           // -2% per 1% deviation
    const alarmHealth = Math.max(0, 100 - Math.min(totalAlarms, 50) * 2); // -2% per alarm
    const availHealth = availability != null ? availability : 90;
    const overallHealth = Math.round((cycleHealth * 0.3) + (alarmHealth * 0.3) + (availHealth * 0.4));

    // 9. Recommendations
    const recs = [];
    if (cycleDev > 15) recs.push({ level:'warn',  msg:`⚠️ Cycle time ${parseFloat(cycle.avg_cycle).toFixed(0)}s is ${cycleDev.toFixed(0)}% above ideal (${idealCycle}s) — check tool wear` });
    if (cycleDev > 30) recs.push({ level:'crit',  msg:`🔴 Severe cycle deviation — consider tool change immediately` });
    if (totalAlarms > 10) recs.push({ level:'warn', msg:`⚠️ ${totalAlarms} alarms in last ${hours}h — review alarm log` });
    if (totalAlarms > 30) recs.push({ level:'crit', msg:`🚨 High alarm frequency — machine may need maintenance` });
    if (availability != null && availability < 75) recs.push({ level:'warn', msg:`⚠️ Availability ${availability}% below 75% target — check for stoppages` });
    if (parseFloat(cycle.stddev_cycle) > 10) recs.push({ level:'warn', msg:`📊 High cycle time variability (σ=${parseFloat(cycle.stddev_cycle).toFixed(1)}s) — process instability detected` });
    if (recs.length === 0) recs.push({ level:'ok', msg:`✅ Machine running healthy — no immediate action required` });

    res.json({
      ok: true, machine, hours,
      health: { overall: overallHealth, cycle: Math.round(cycleHealth), alarm: Math.round(alarmHealth), availability: availHealth },
      live, cycle, alarms, totalAlarms, availability,
      trend, ctTrend, alarmTrend, recommendations: recs,
      timestamp: new Date().toISOString()
    });

  } catch(e) {
    console.error('[Predict-CNC]', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ── CNC OEE: shift OEE breakdown ─────────────────────────────────
// GET /api/cnc/oee?date=YYYY-MM-DD&shift=A|B
// ── Reads from oee_results table (pre-calculated) — falls back to calc_oee() ──
app.get('/api/cnc/oee', async (req, res) => {
  try {
    const machine  = req.query.machine || 'MACHINE001';
    const dateStr  = req.query.date || new Date().toLocaleDateString('en-CA');
    const shiftReq = (req.query.shift || '').toUpperCase();
    const shiftLabel = (shiftReq === 'B') ? 'B' : 'A';
    // TARGET_PARTS is now dynamic: computed from ideal cycle in lookupShiftProgram()
    // Fallback used only if no program found: 12h × 3600 / 45s × 90% ≈ 864
    const TARGET_PARTS_FALLBACK = 864;

    // ── Compute shift window up-front (needed for program lookup in both paths) ──
    let shiftStart, shiftEnd;
    if (shiftLabel === 'B') {
      shiftStart = `${dateStr}T19:00:00+05:30`;
      const nd = new Date(`${dateStr}T19:00:00+05:30`); nd.setDate(nd.getDate() + 1);
      shiftEnd = nd.toISOString().slice(0,10) + 'T07:00:00+05:30';
    } else {
      shiftStart = `${dateStr}T07:00:00+05:30`;
      shiftEnd   = `${dateStr}T19:00:00+05:30`;
    }

    // ── Dynamic program lookup: dominant by cnc_data, fallback by avg cycle match ─
    // Returns { program_no, target_cycle_sec, part_name } or null
    const lookupShiftProgram = async (avgCycle) => {
      // Try 1: dominant program_no in cnc_data this shift
      try {
        const pq = await dbCNC.query(`
          WITH dominant AS (
            SELECT NULLIF(REGEXP_REPLACE(program_no::TEXT,'[^0-9]','','g'),'')::INT AS prog_int
            FROM cnc_data
            WHERE machine_id=$1 AND time>=$2::timestamptz AND time<$3::timestamptz
              AND program_no IS NOT NULL
              AND NULLIF(REGEXP_REPLACE(program_no::TEXT,'[^0-9]','','g'),'') IS NOT NULL
            GROUP BY program_no ORDER BY COUNT(*) DESC LIMIT 1
          )
          SELECT pm.program_no, pm.target_cycle_sec, pm.part_name
          FROM program_master pm INNER JOIN dominant d ON pm.program_no = d.prog_int
          WHERE pm.target_cycle_sec IS NOT NULL LIMIT 1
        `, [machine, shiftStart, shiftEnd]);
        if (pq.rows.length) return pq.rows[0];
      } catch(_) {}

      // Try 2: best-match by avg actual cycle time (within ±90s of any program)
      if (avgCycle > 0) {
        try {
          const pq2 = await dbCNC.query(`
            SELECT program_no, target_cycle_sec, part_name,
                   ABS(target_cycle_sec - $1) AS diff
            FROM program_master
            WHERE target_cycle_sec IS NOT NULL
            ORDER BY diff LIMIT 1
          `, [avgCycle]);
          if (pq2.rows.length && parseFloat(pq2.rows[0].diff) < 90) return pq2.rows[0];
        } catch(_) {}
      }

      // Try 3: most recently updated program for this machine
      try {
        const pq3 = await dbCNC.query(`
          SELECT program_no, target_cycle_sec, part_name
          FROM program_master
          WHERE machine_id = $1 AND target_cycle_sec IS NOT NULL
          ORDER BY updated_at DESC NULLS LAST LIMIT 1
        `, [machine]);
        if (pq3.rows.length) return pq3.rows[0];
      } catch(_) {}

      return null;
    };

    // ── Primary: read from oee_results table ──────────────────────
    const rr = await dbCNC.query(
      `SELECT * FROM oee_results
       WHERE machine_id = $1 AND shift_date = $2 AND shift = $3
       LIMIT 1`,
      [machine, dateStr, shiftLabel]
    );

    // ── Previous shift OEE (last completed shift before this one) ──
    const rPrev = await dbCNC.query(
      `SELECT shift_date::text AS date, shift, ROUND(oee::numeric,1) AS oee,
              ROUND(availability::numeric,1) AS availability,
              ROUND(performance::numeric,1) AS performance,
              ROUND(quality::numeric,1) AS quality,
              parts_produced
       FROM oee_results
       WHERE machine_id = $1 AND (shift_date < $2 OR (shift_date = $2 AND shift < $3))
       ORDER BY shift_date DESC, shift DESC
       LIMIT 1`,
      [machine, dateStr, shiftLabel]
    );
    const prevShift = rPrev.rows[0] || null;

    if (rr.rows.length > 0) {
      const d = rr.rows[0];
      const storedAvgCycle = parseFloat(d.avg_cycle_sec) || 0;
      // Dynamic program lookup — overrides the stored (possibly default 45s) target cycle
      const prog = await lookupShiftProgram(storedAvgCycle);
      const dynTargetCycle = prog ? parseFloat(prog.target_cycle_sec) : (parseFloat(d.target_cycle_sec) || 45);
      const dynProgNo      = prog ? prog.program_no : null;
      const dynPartName    = prog ? prog.part_name  : null;

      // Always recalculate Performance with the dynamic (correct) target cycle
      const runSec = parseFloat(d.running_sec) || 0;
      const parts  = parseInt(d.parts_produced) || 0;
      let correctedPerf = parseFloat(d.performance);
      if (runSec > 0 && parts > 0 && dynTargetCycle > 0) {
        correctedPerf = Math.min(100, Math.round(parts * dynTargetCycle / runSec * 100 * 100) / 100);
      }
      const correctedOEE = Math.min(100, Math.round(
        parseFloat(d.availability) * correctedPerf * parseFloat(d.quality) / 10000 * 100) / 100);

      return res.json({
        ok: true, shift: shiftLabel, date: dateStr, machine,
        source: 'oee_results',
        prev_shift: prevShift,
        program_no:         dynProgNo,
        part_name:          dynPartName,
        availability:       parseFloat(d.availability),
        performance:        correctedPerf,
        quality:            parseFloat(d.quality),
        oee:                correctedOEE,
        parts_produced:     parseInt(d.parts_produced),
        // Recalculate target_parts using the correct ideal cycle (12h × 3600 / ideal × 90%)
        target_parts:       Math.floor(43200 / dynTargetCycle),
        rejection_count:    parseInt(d.rejection_count),
        good_parts:         parseInt(d.good_parts),
        scrap_rate:         parseFloat(d.scrap_rate),
        parts_attainment:   parseFloat(d.parts_attainment),
        running_sec:        parseFloat(d.running_sec),
        downtime_sec:       parseFloat(d.downtime_sec),
        major_downtime_sec: parseFloat(d.major_downtime_sec),
        minor_downtime_sec: parseFloat(d.minor_downtime_sec),
        producing_sec:      parseFloat(d.producing_sec),
        minor_stop_sec:     parseFloat(d.minor_stop_sec),
        idle_sec:           parseFloat(d.idle_sec),
        net_available_sec:  parseFloat(d.net_available_sec),
        running_min:        parseFloat(d.running_min),
        downtime_min:       parseFloat(d.downtime_min),
        major_downtime_min: parseFloat(d.major_downtime_min),
        minor_downtime_min: parseFloat(d.minor_downtime_min),
        avg_cycle_time:     parseFloat(d.avg_cycle_sec),
        best_cycle_time:    parseFloat(d.best_cycle_sec),
        worst_cycle_time:   parseFloat(d.worst_cycle_sec),
        cycle_efficiency:   parseFloat(d.cycle_efficiency),
        target_cycle_time:  dynTargetCycle,   // ← always the real program ideal, never 45 default
        alarm_count:        parseInt(d.alarm_count),
        rows_count:         parseInt(d.rows_count),
        calculated_at:      d.calculated_at,
      });
    }

    // ── Fallback: calculate via calc_oee() SQL function ───────────
    // (shiftStart / shiftEnd already computed above)

    const r = await dbCNC.query(
      `SELECT * FROM calc_oee($1, $2::timestamptz, $3::timestamptz)`,
      [machine, shiftStart, shiftEnd]
    );
    const d = r.rows[0];
    if (!d || parseInt(d.rows_count) === 0) {
      const emptyProg = await lookupShiftProgram(0);
      const emptyIdeal = emptyProg ? parseFloat(emptyProg.target_cycle_sec) : 45;
      return res.json({
        ok: true, shift: shiftLabel, date: dateStr, rows_count: 0,
        availability: 0, performance: 0, quality: 100, oee: 0,
        parts_produced: 0,
        target_parts: Math.floor(43200 / emptyIdeal),
        target_cycle_time: emptyIdeal,
        program_no: emptyProg ? emptyProg.program_no : null,
        running_sec: 0, net_available_sec: 40500,
        prev_shift: prevShift,
        message: 'No data for this shift'
      });
    }

    const cr = await dbCNC.query(
      `SELECT ROUND(AVG(last_cycle_time_sec)::numeric, 1) AS avg_cycle,
              ROUND(MIN(last_cycle_time_sec)::numeric, 1) AS best_cycle
       FROM cnc_data
       WHERE machine_id=$1 AND time >= $2 AND time < $3
         AND last_cycle_time_sec > 0`,
      [machine, shiftStart, shiftEnd]
    );
    const cy = cr.rows[0] || {};
    const fbAvgCycle = parseFloat(cy.avg_cycle || 0);
    // Dynamic program lookup for fallback path too
    const fbProg = await lookupShiftProgram(fbAvgCycle);
    const fbTargetCycle = fbProg ? parseFloat(fbProg.target_cycle_sec) : (fbAvgCycle || 45);

    res.json({
      ok: true, shift: shiftLabel, date: dateStr, machine,
      source: 'calc_oee_fallback',
      prev_shift: prevShift,
      program_no:      fbProg ? fbProg.program_no : null,
      part_name:       fbProg ? fbProg.part_name  : null,
      availability:    parseFloat(d.availability),
      performance:     parseFloat(d.performance),
      quality:         parseFloat(d.quality),
      oee:             parseFloat(d.oee),
      parts_produced:  parseInt(d.parts_produced),
      target_parts:    Math.floor(43200 / fbTargetCycle),
      running_sec:     Math.round(d.running_sec),
      downtime_sec:    Math.round(d.downtime_sec),
      producing_sec:   Math.round(d.producing_sec),
      minor_stop_sec:  Math.round(d.minor_stop_sec),
      idle_sec:        Math.round(d.idle_sec),
      net_available_sec: 40500,
      avg_cycle_time:  fbAvgCycle,
      best_cycle_time: parseFloat(cy.best_cycle || 0),
      target_cycle_time: fbTargetCycle,   // ← correct program ideal, not avg
      rows_count:      parseInt(d.rows_count),
      running_min:     Math.round(d.running_sec  / 60),
      downtime_min:    Math.round(d.downtime_sec / 60),
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── CNC OEE: shift history list (alias used by dashboard pages) ──
// GET /api/cnc/shifts?machine=MACHINE-001&limit=14
// Returns last N shifts from oee_results table
app.get('/api/cnc/shifts', async (req, res) => {
  cors(res);
  try {
    const machine = req.query.machine || 'MACHINE001';
    const limit   = Math.min(50, parseInt(req.query.limit) || 14);
    const r = await dbCNC.query(
      `SELECT
         shift_date::text AS date,
         shift,
         machine_id,
         ROUND(oee::numeric, 1)          AS oee,
         ROUND(availability::numeric, 1) AS availability,
         ROUND(performance::numeric, 1)  AS performance,
         ROUND(quality::numeric, 1)      AS quality,
         -- Use parts from DB; if 0 but performance>0, back-calculate an estimate
         CASE WHEN parts_produced > 0 THEN parts_produced
              WHEN performance > 0 AND running_sec > 0
              THEN GREATEST(0, ROUND(performance * running_sec / NULLIF(target_cycle_sec, 45) / 100))
              ELSE 0 END                AS parts_produced,
         target_parts,
         parts_attainment,
         rejection_count,
         good_parts,
         -- Use stored avg_cycle; if 0 but cycle_efficiency>0, back-calc from target
         CASE WHEN avg_cycle_sec > 0 THEN ROUND(avg_cycle_sec::numeric, 1)
              WHEN cycle_efficiency > 0
              THEN ROUND((target_cycle_sec * 100.0 / NULLIF(cycle_efficiency,0))::numeric, 1)
              ELSE NULL END             AS avg_cycle_sec,
         ROUND(best_cycle_sec::numeric, 1) AS best_cycle_sec,
         ROUND(running_sec::numeric, 0)    AS running_sec,
         ROUND(downtime_sec::numeric, 0)   AS downtime_sec,
         alarm_count,
         calculated_at
       FROM oee_results
       WHERE machine_id = $1
       ORDER BY shift_date DESC, shift DESC
       LIMIT $2`,
      [machine, limit]
    );

    // ── Apply same dynamic ideal-cycle correction as /api/cnc/oee ──────────
    // oee_results rows may have stored target_cycle_sec=45 (wrong default).
    // Look up the correct cycle from program_master once and recalculate.
    let dynIdealCycle = 0;
    try {
      // Try 1: best avg-cycle match across all rows
      const allCycles = r.rows.map(s => parseFloat(s.avg_cycle_sec)||0).filter(c => c > 0);
      const avgCycle  = allCycles.length ? allCycles.reduce((a,b)=>a+b,0)/allCycles.length : 0;

      // Try dominant program from recent cnc_data
      const domProg = await dbCNC.query(
        `SELECT program_no, COUNT(*) AS cnt
           FROM cnc_data WHERE machine_id=$1 AND time > NOW()-INTERVAL '7 days'
           AND program_no IS NOT NULL AND program_no > 0
           GROUP BY program_no ORDER BY cnt DESC LIMIT 1`, [machine]).catch(()=>({rows:[]}));
      if (domProg.rows.length) {
        const pm = await dbCNC.query(
          `SELECT target_cycle_sec FROM program_master WHERE program_no=$1 AND target_cycle_sec > 0 LIMIT 1`,
          [domProg.rows[0].program_no]).catch(()=>({rows:[]}));
        if (pm.rows.length) dynIdealCycle = parseFloat(pm.rows[0].target_cycle_sec);
      }
      // Fallback: match by avg cycle time
      if (!dynIdealCycle && avgCycle > 0) {
        const pm2 = await dbCNC.query(
          `SELECT target_cycle_sec FROM program_master
             WHERE target_cycle_sec IS NOT NULL AND target_cycle_sec > 0
             ORDER BY ABS(target_cycle_sec - $1) LIMIT 1`, [avgCycle]).catch(()=>({rows:[]}));
        if (pm2.rows.length) dynIdealCycle = parseFloat(pm2.rows[0].target_cycle_sec);
      }
      // Fallback: most recent program for machine
      if (!dynIdealCycle) {
        const pm3 = await dbCNC.query(
          `SELECT target_cycle_sec FROM program_master
             WHERE machine_id=$1 AND target_cycle_sec > 0
             ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [machine]).catch(()=>({rows:[]}));
        if (pm3.rows.length) dynIdealCycle = parseFloat(pm3.rows[0].target_cycle_sec);
      }
    } catch(e2) { /* best-effort */ }

    // Recalculate each row if we found a better ideal cycle
    const correctedRows = r.rows.map(s => {
      const storedCycle = parseFloat(s.target_cycle_sec) || 45;
      const idealCycle  = (dynIdealCycle > 0 && dynIdealCycle !== storedCycle && storedCycle <= 45)
        ? dynIdealCycle : storedCycle;
      const parts    = parseInt(s.parts_produced)  || 0;
      const runSec   = parseFloat(s.running_sec)   || 0;
      const avail    = parseFloat(s.availability)  || 0;
      const qual     = parseFloat(s.quality)        || 100;
      let corrPerf   = parseFloat(s.performance)   || 0;
      let corrOEE    = parseFloat(s.oee)            || 0;
      if (idealCycle > storedCycle && parts > 0 && runSec > 0) {
        corrPerf = Math.min(100, Math.round(parts * idealCycle / runSec * 100 * 10) / 10);
        corrOEE  = Math.min(100, Math.round(avail * corrPerf * qual / 10000 * 10) / 10);
      }
      const dynTgt = idealCycle > 0 ? Math.floor(43200 / idealCycle) : (parseInt(s.target_parts)||0);
      return {
        ...s,
        shift_date:       s.date || s.shift_date,
        performance:      corrPerf,
        oee:              corrOEE,
        target_cycle_sec: idealCycle,
        target_parts:     dynTgt,
      };
    });

    res.json({ ok: true, shifts: correctedRows, count: correctedRows.length });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message, shifts: [] });
  }
});

// ── CNC OEE: today's shifts summary ──────────────────────────────
// GET /api/cnc/shift-summary
// ── Reads from oee_results table (pre-calculated every 5 min) ──
app.get('/api/cnc/shift-summary', async (req, res) => {
  try {
    const shiftDate    = getISTShiftDate();
    const istNow       = new Date(Date.now() + 5.5 * 3600 * 1000);
    const _istTotalMin = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
    const currentShift = (_istTotalMin >= 7*60 && _istTotalMin < 19*60) ? 'A' : 'B';

    // Pull from oee_results table — rich detail including downtime classification
    const r = await dbCNC.query(
      `SELECT
         shift_date::text AS date, shift, machine_id,
         oee, availability, performance, quality,
         parts_produced, target_parts, parts_attainment,
         rejection_count, good_parts, scrap_rate,
         running_sec, downtime_sec, net_available_sec,
         major_downtime_sec, minor_downtime_sec,
         major_downtime_min, minor_downtime_min,
         running_min, downtime_min,
         avg_cycle_sec, best_cycle_sec, worst_cycle_sec,
         cycle_efficiency, target_cycle_sec,
         alarm_count, rows_count, calculated_at
       FROM oee_results
       WHERE machine_id = 'MACHINE001' AND shift_date = $1
       ORDER BY shift`,
      [shiftDate]
    );

    // Fallback to v_oee_shifts view if oee_results not yet populated
    let rows = r.rows;
    if (rows.length === 0) {
      const fallback = await dbCNC.query(
        `SELECT shift_date::text AS date, shift,
                availability, performance, quality, oee,
                parts_produced, running_sec, downtime_sec,
                minor_stop_sec, idle_sec, rows_count,
                ROUND(running_sec/60,1)  AS running_min,
                ROUND(downtime_sec/60,1) AS downtime_min
         FROM v_oee_shifts
         WHERE shift_date = $1
         ORDER BY shift`,
        [shiftDate]
      );
      rows = fallback.rows;
    }

    const shiftA = rows.find(rr => rr.shift === 'A') || null;
    const shiftB = rows.find(rr => rr.shift === 'B') || null;

    // Use stored values from oee_results if available
    const targetCycleSec = parseFloat(shiftA?.target_cycle_sec || shiftB?.target_cycle_sec || 45);
    const targetPartsVal = parseInt(shiftA?.target_parts || shiftB?.target_parts || 900);
    res.json({
      ok: true, date: todayIST, current_shift: currentShift,
      shift_a: shiftA, shift_b: shiftB,
      target_parts: targetPartsVal, target_cycle_time: targetCycleSec,
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── CNC OEE: daily production trend ──────────────────────────────
// GET /api/cnc/production-trend?days=7
// ── Reads from v_oee_daily_summary (built from oee_results table) ──
// ── Parameter Report: summary from oee_results (correct part totals) ─
app.get('/api/cnc/report-summary', async (req, res) => {
  try {
    const machine  = req.query.machine  || 'MACHINE001';
    const fromDate = req.query.from     || new Date().toISOString().slice(0,10);
    const toDate   = req.query.to       || new Date().toISOString().slice(0,10);
    const r = await dbCNC.query(
      `SELECT
         COALESCE(SUM(parts_produced), 0)                         AS total_parts,
         COALESCE(ROUND(AVG(avg_cycle_sec)::numeric, 1), 0)       AS avg_cycle_sec,
         COALESCE(SUM(running_sec), 0)                            AS total_running_sec,
         COALESCE(SUM(net_available_sec), 0)                      AS total_net_sec,
         COALESCE(ROUND(AVG(oee)::numeric, 1), 0)                 AS avg_oee,
         COALESCE(ROUND(AVG(availability)::numeric, 1), 0)        AS avg_avail,
         COALESCE(ROUND(AVG(performance)::numeric,  1), 0)        AS avg_perf,
         COUNT(*)                                                  AS shift_count
       FROM oee_results
       WHERE machine_id = $1
         AND shift_date >= $2::date
         AND shift_date <= $3::date`,
      [machine, fromDate, toDate]
    );
    const d = r.rows[0] || {};
    const runSec   = parseFloat(d.total_running_sec || 0);
    const netSec   = parseFloat(d.total_net_sec     || 0);
    const utilPct  = netSec > 0 ? Math.min(100, (runSec / netSec * 100)).toFixed(1) : '0.0';
    const runH     = Math.floor(runSec / 3600);
    const runM     = Math.floor((runSec % 3600) / 60);
    res.json({
      ok: true,
      total_parts:    parseInt(d.total_parts     || 0),
      avg_cycle_sec:  parseFloat(d.avg_cycle_sec || 0),
      runtime_h:      runH,
      runtime_m:      runM,
      runtime_sec:    runSec,
      utilization_pct: parseFloat(utilPct),
      avg_oee:        parseFloat(d.avg_oee  || 0),
      avg_avail:      parseFloat(d.avg_avail|| 0),
      avg_perf:       parseFloat(d.avg_perf || 0),
      shift_count:    parseInt(d.shift_count|| 0),
      from: fromDate, to: toDate
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/cnc/production-trend', async (req, res) => {
  try {
    const days = Math.min(30, parseInt(req.query.days) || 7);

    // Primary: v_oee_daily_summary (built from oee_results — both shifts rolled up)
    const r = await dbCNC.query(
      `SELECT
         shift_date                                       AS day,
         ROUND(AVG(availability)::numeric, 2)            AS availability,
         ROUND(AVG(performance)::numeric,  2)            AS performance,
         ROUND(AVG(quality)::numeric,      2)            AS quality,
         ROUND(AVG(oee)::numeric,          2)            AS oee,
         SUM(parts_produced)                             AS parts,
         SUM(target_parts)                               AS target_parts,
         ROUND(SUM(parts_produced)::numeric / NULLIF(SUM(target_parts),0) * 100, 1) AS attainment_pct,
         SUM(running_sec)                                AS running_sec,
         SUM(downtime_sec)                               AS downtime_sec,
         SUM(major_downtime_sec)                         AS major_downtime_sec,
         SUM(minor_downtime_sec)                         AS minor_downtime_sec,
         ROUND(SUM(running_sec)::numeric   / 60, 1)     AS running_min,
         ROUND(SUM(downtime_sec)::numeric  / 60, 1)     AS downtime_min,
         ROUND(AVG(avg_cycle_sec)::numeric, 1)           AS avg_cycle_sec,
         MIN(best_cycle_sec)                             AS best_cycle_sec,
         SUM(alarm_count)                                AS alarm_count,
         SUM(rejection_count)                            AS rejection_count,
         SUM(rows_count)                                 AS readings
       FROM oee_results
       WHERE machine_id = 'MACHINE001'
         AND shift_date >= CURRENT_DATE - ($1 || ' days')::interval
       GROUP BY shift_date
       ORDER BY shift_date ASC`,
      [days]
    );

    // Fallback to v_oee_daily if oee_results has no data yet
    let trendRows = r.rows;
    if (trendRows.length === 0) {
      const fallback = await dbCNC.query(
        `SELECT
           day,
           availability, performance, quality, oee,
           parts_produced AS parts,
           900            AS target_parts,
           ROUND(parts_produced::numeric / 900 * 100, 1) AS attainment_pct,
           running_sec, downtime_sec,
           ROUND(running_sec::numeric  / 60, 1) AS running_min,
           ROUND(downtime_sec::numeric / 60, 1) AS downtime_min,
           total_rows AS readings
         FROM v_oee_daily
         WHERE day >= CURRENT_DATE - ($1 || ' days')::interval
         ORDER BY day ASC`,
        [days]
      );
      trendRows = fallback.rows;
    }

    const trend = trendRows.map(row => ({
      day:               row.day,
      availability:      parseFloat(row.availability   || 0),
      performance:       parseFloat(row.performance    || 0),
      quality:           parseFloat(row.quality        || 0),
      oee:               parseFloat(row.oee            || 0),
      parts:             parseInt(row.parts            || 0),
      target_parts:      parseInt(row.target_parts     || 900),
      attainment_pct:    parseFloat(row.attainment_pct || 0),
      running_sec:       parseFloat(row.running_sec    || 0),
      downtime_sec:      parseFloat(row.downtime_sec   || 0),
      major_downtime_sec:parseFloat(row.major_downtime_sec || 0),
      minor_downtime_sec:parseFloat(row.minor_downtime_sec || 0),
      running_min:       parseFloat(row.running_min    || 0),
      downtime_min:      parseFloat(row.downtime_min   || 0),
      avg_cycle_sec:     parseFloat(row.avg_cycle_sec  || 0),
      best_cycle_sec:    parseFloat(row.best_cycle_sec || 0),
      alarm_count:       parseInt(row.alarm_count      || 0),
      rejection_count:   parseInt(row.rejection_count  || 0),
      readings:          parseInt(row.readings         || 0),
    }));

    // Use most recent stored cycle time from oee_results
    let trendCycle = 45, trendTarget = 900;
    try {
      const tcR = await dbCNC.query(
        `SELECT target_cycle_sec, target_parts FROM oee_results
         WHERE machine_id='MACHINE001' AND target_cycle_sec > 0
         ORDER BY shift_date DESC, shift DESC LIMIT 1`
      );
      if (tcR.rows[0]) {
        trendCycle  = parseFloat(tcR.rows[0].target_cycle_sec);
        trendTarget = parseInt(tcR.rows[0].target_parts);
      }
    } catch(_) {}
    res.json({ ok: true, days, target_parts: trendTarget, target_cycle: trendCycle, trend });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// Facto-Bot — AI-powered CNC natural-language query engine
// POST /api/cnc/chat  { question: "..." }
//
// Flow:
//   1. If ANTHROPIC_API_KEY set → use Claude (claude-agent.js)
//      claude-sonnet-4-6 generates SQL → executes → claude-haiku formats answer
//   2. Else → rule-based fallback (fast, no API needed)
// ═══════════════════════════════════════════════════════════════
app.post('/api/cnc/chat', aiLimiter, async (req, res) => {
  cors(res);
  try {
    const { question = '', mode } = req.body;
    if (!question.trim()) return res.json({ ok: false, error: 'Empty question' });
    const chatMode = (mode || 'chat').toLowerCase();

    // ── Try Free AI (Groq / Gemini / Ollama) — mode-aware ────────
    try {
      const freeResult = await freeAIAnswer(question, dbCNC, chatMode);
      if (freeResult) return res.json({
        ok: true, answer: freeResult.text,
        sql_ref: freeResult.sql || '', rows_analyzed: freeResult.rows,
        engine: freeResult.engine, model: freeResult.model,
        mode: chatMode, chart_config: freeResult.chart_config || null,
        data: freeResult.data || null,
      });
    } catch(freeErr) { console.warn('[Facto-Bot] Free AI error:', freeErr.message); }

    // ── Try Claude agent (paid) ───────────────────────────────────
    const geminiKey    = process.env.GEMINI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const hasAI = (geminiKey && geminiKey.length > 10) ||
                  (anthropicKey && anthropicKey.startsWith('sk-ant-'));
    if (hasAI) {
      try {
        const result = await aiAnswer(question, dbCNC, {
          geminiKey:    geminiKey    || null,
          anthropicKey: anthropicKey || null,
        });
        return res.json({
          ok:            true,
          answer:        result.text,
          sql_ref:       result.sql || '',
          rows_analyzed: result.rows,
          engine:        result.engine,
          model:         result.model,
          mode:          chatMode,
        });
      } catch(aiErr) {
        console.warn('[Facto-Bot] AI error, falling back to rule-based:', aiErr.message);
      }
    }

    // ── Rule-based fallback (no API key or Claude failed) ─────────
    const q = question.toLowerCase().trim();
    const machine = 'MACHINE001';
    const TARGET_CYCLE = 45;
    const NET_AVAILABLE_SEC = 40500;
    const TARGET_PARTS = 900;

    const now = new Date();
    const istOffset = 5.5 * 3600000;
    const istNow = new Date(now.getTime() + istOffset);
    const todayIST = istNow.toISOString().slice(0, 10);
    const _istTotalMin = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
    const currentShift = (_istTotalMin >= 7*60 && _istTotalMin < 19*60) ? 'A' : 'B';

    let fromTime, timeLabel, explicitTimeWindow = false;
    if (q.match(/last\s*1\s*hour|past\s*hour|last\s*hour/)) {
      fromTime = new Date(now - 3600000); timeLabel = 'last 1 hour'; explicitTimeWindow = true;
    } else if (q.match(/last\s*[24]\s*hour|last\s*(two|four|2|4)\s*hour/)) {
      const h = q.match(/4|four/) ? 4 : 2;
      fromTime = new Date(now - h*3600000); timeLabel = `last ${h} hours`; explicitTimeWindow = true;
    } else if (q.match(/last\s*[68]\s*hour|last\s*(six|eight|6|8)\s*hour/)) {
      const h = q.match(/8|eight/) ? 8 : 6;
      fromTime = new Date(now - h*3600000); timeLabel = `last ${h} hours`; explicitTimeWindow = true;
    } else if (q.match(/last\s*(\d+)\s*min/)) {
      const mins = parseInt(q.match(/last\s*(\d+)\s*min/)[1]);
      fromTime = new Date(now - mins*60000); timeLabel = `last ${mins} minutes`; explicitTimeWindow = true;
    } else if (q.includes('yesterday')) {
      const y = new Date(`${todayIST}T00:00:00+05:30`);
      y.setDate(y.getDate()-1);
      fromTime = y; timeLabel = 'yesterday';
    } else if (q.includes('today') || q.includes('24')) {
      fromTime = new Date(`${todayIST}T00:00:00+05:30`); timeLabel = 'today';
    } else if (q.includes('shift a')) {
      fromTime = new Date(`${todayIST}T07:00:00+05:30`); timeLabel = 'Shift A (07:00–19:00)';
    } else if (q.includes('shift b')) {
      const d2 = (currentShift==='B' && _istTotalMin<7*60) ? new Date(now-86400000).toISOString().slice(0,10) : todayIST;
      fromTime = new Date(`${d2}T19:00:00+05:30`); timeLabel = 'Shift B (19:00–07:00)';
    } else {
      if (currentShift === 'A') {
        fromTime = new Date(`${todayIST}T07:00:00+05:30`);
      } else {
        const d2 = _istTotalMin<7*60 ? new Date(now-86400000).toISOString().slice(0,10) : todayIST;
        fromTime = new Date(`${d2}T19:00:00+05:30`);
      }
      timeLabel = `current Shift ${currentShift}`;
    }

    // ── Fetch from oee_results for OEE-type queries (faster) ──────
    // SKIP oee_results when user asks for a specific time window (last N hours/min)
    // because oee_results only has shift totals, not sub-shift breakdowns
    if (!explicitTimeWindow && q.match(/oee|availability|performance|quality|downtime|parts|production|attainment/)) {
      try {
        const oeeR = await dbCNC.query(
          `SELECT * FROM oee_results WHERE machine_id=$1 AND shift_date=$2 ORDER BY shift`,
          ['MACHINE001', getISTShiftDate()]
        );
        if (oeeR.rows.length > 0) {
          const d = oeeR.rows; // may be Shift A + Shift B
          const cur = d.find(r => r.shift === currentShift) || d[0];
          const f1 = v => parseFloat(v||0).toFixed(1);
          const fi = v => Math.round(parseFloat(v||0));
          let answer = '';
          if (q.includes('oee')) {
            answer  = `📊 OEE — ${timeLabel}:\n`;
            answer += `🎯 OEE: **${f1(cur.oee)}%**  (${cur.oee>=80?'🟢 World Class':cur.oee>=65?'🟡 Typical':'🔴 Needs Attention'})\n\n`;
            answer += `• Availability : ${f1(cur.availability)}%\n`;
            answer += `• Performance  : ${f1(cur.performance)}%\n`;
            answer += `• Quality      : ${f1(cur.quality)}%\n\n`;
            answer += `🏭 Parts: ${fi(cur.parts_produced)} / ${fi(cur.target_parts)} target (${f1(cur.parts_attainment)}%)\n`;
            answer += `⏱ Running: ${fi(cur.running_min)} min | Down: ${fi(cur.downtime_min)} min\n`;
            answer += `📅 Shift ${cur.shift} | ${cur.shift_date} | From oee_results`;
          } else if (q.includes('availab') || q.includes('downtime')) {
            answer  = `⏱ Availability — Shift ${cur.shift}, ${timeLabel}: **${f1(cur.availability)}%**\n\n`;
            answer += `• Running time   : ${fi(cur.running_min)} min\n`;
            answer += `• Total downtime : ${fi(cur.downtime_min)} min\n`;
            answer += `• Major downtime : ${fi(cur.major_downtime_min)} min  (machine STOP/ALARM)\n`;
            answer += `• Minor stops    : ${fi(cur.minor_downtime_min)} min  (spindle idle)\n`;
            answer += `• Net available  : ${fi(cur.net_available_sec/60)} min\n`;
          } else if (q.includes('perform')) {
            answer  = `⚡ Performance — Shift ${cur.shift}: **${f1(cur.performance)}%**\n\n`;
            answer += `• Parts produced : ${fi(cur.parts_produced)} pcs\n`;
            answer += `• Avg cycle time : ${f1(cur.avg_cycle_sec)} sec  (target 45s)\n`;
            answer += `• Best cycle     : ${f1(cur.best_cycle_sec)} sec\n`;
            answer += `• Cycle efficiency: ${f1(cur.cycle_efficiency)}%\n`;
          } else if (q.includes('part') || q.includes('produc')) {
            answer  = `🏭 Production — Shift ${cur.shift}:\n\n`;
            answer += `• Parts produced : **${fi(cur.parts_produced)} pcs**\n`;
            answer += `• Target         : ${fi(cur.target_parts)} pcs\n`;
            answer += `• Attainment     : ${f1(cur.parts_attainment)}%\n`;
            answer += `• Shortfall      : ${Math.max(0, cur.target_parts - cur.parts_produced)} pcs\n`;
            answer += `• Good parts     : ${fi(cur.good_parts)} pcs\n`;
            answer += `• Rejections     : ${fi(cur.rejection_count)} pcs\n`;
          }
          return res.json({
            ok: true, answer, sql_ref:
            `SELECT * FROM oee_results WHERE machine_id='MACHINE001' AND shift_date='${todayIST}'`,
            time_range: timeLabel, rows_analyzed: oeeR.rows.length, engine: 'rule-oee_results'
          });
        }
      } catch(e2) { /* fall through to raw cnc_data */ }
    }

    // ── Raw cnc_data fallback ───────────────────────────────────────
    const r = await dbCNC.query(
      `SELECT time, machine_state, is_running, spindle_speed, feed_rate,
              raw_cycle_time_sec, part_count, alarm_active, alarm_no,
              last_cycle_time_sec, program_no
       FROM cnc_data
       WHERE machine_id=$1 AND time >= $2 AND time <= $3
       ORDER BY time ASC`,
      [machine, fromTime.toISOString(), now.toISOString()]
    );
    const rows = r.rows;

    if (!rows.length) {
      return res.json({
        ok: true,
        answer: `⚠️ No data found for **${timeLabel}**.\n\nTime range: ${fromTime.toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} → now\n\nCheck:\n• Node-RED is running\n• Machine is powered on\n• Try: "last 1 hour" or "today"`,
        sql_ref: `SELECT * FROM cnc_data WHERE machine_id='MACHINE001' AND time >= '${fromTime.toISOString()}'`,
        rows_found: 0, engine: 'rule-machine001'
      });
    }

    let running_sec = 0, down_sec = 0;
    for (let i = 1; i < rows.length; i++) {
      const gap = (new Date(rows[i].time) - new Date(rows[i-1].time)) / 1000;
      if (gap <= 0 || gap > 600) continue;
      const st = (rows[i-1].machine_state||'').toUpperCase();
      if (st === 'RUNNING' || rows[i-1].is_running) running_sec += gap;
      else down_sec += gap;
    }

    const pCounts = rows.map(rr=>parseInt(rr.part_count||0)).filter(v=>!isNaN(v)&&v>=0);
    const parts   = pCounts.length ? Math.max(...pCounts)-Math.min(...pCounts) : 0;
    const elapsed  = Math.max(1, (now - fromTime)/1000);
    const net_avail = Math.min(elapsed, NET_AVAILABLE_SEC);
    const avail_pct = Math.min(100, running_sec/net_avail*100);
    const perf_pct  = running_sec > 0 ? Math.min(100, parts*TARGET_CYCLE/running_sec*100) : 0;
    const oee_pct   = avail_pct * perf_pct / 10000;

    const cycleRows = rows.filter(rr=>parseFloat(rr.last_cycle_time_sec||0)>0);
    const avgCycle  = cycleRows.length ? cycleRows.reduce((s,rr)=>s+parseFloat(rr.last_cycle_time_sec),0)/cycleRows.length : 0;
    const minCycle  = cycleRows.length ? Math.min(...cycleRows.map(rr=>parseFloat(rr.last_cycle_time_sec))) : 0;
    const lastRow   = rows[rows.length-1];
    const alarmRows = rows.filter(rr=>rr.alarm_active);
    const alarmNos  = [...new Set(alarmRows.map(rr=>rr.alarm_no).filter(Boolean))];
    const spRows    = rows.filter(rr=>parseFloat(rr.spindle_speed||0)>0);
    const avgSpin   = spRows.length ? spRows.reduce((s,rr)=>s+parseFloat(rr.spindle_speed),0)/spRows.length : 0;
    const feedRows  = rows.filter(rr=>parseFloat(rr.feed_rate||0)>0);
    const avgFeed   = feedRows.length ? feedRows.reduce((s,rr)=>s+parseFloat(rr.feed_rate),0)/feedRows.length : 0;
    const f1=v=>parseFloat(v).toFixed(1), fi=v=>Math.round(v);
    const fmtT=ts=>new Date(ts).toLocaleTimeString('en-IN',{hour12:false,timeZone:'Asia/Kolkata'});

    let answer='', sql_ref='';

    if (q.includes('oee') && !q.includes('perform') && !q.includes('avail')) {
      answer  = `📊 OEE — ${timeLabel}: **${f1(oee_pct)}%**\n\n`;
      answer += `• Availability : ${f1(avail_pct)}%\n• Performance  : ${f1(perf_pct)}%\n• Quality      : 100%\n\n`;
      answer += `Formula: ${f1(avail_pct)}% × ${f1(perf_pct)}% × 100% ÷ 10000 = ${f1(oee_pct)}%\n`;
      answer += `📊 ${rows.length} readings analyzed`;
      sql_ref = `SELECT time, machine_state, part_count, last_cycle_time_sec FROM cnc_data\nWHERE machine_id='MACHINE001' AND time >= '${fromTime.toISOString()}'`;
    } else if (q.includes('availab') || q.includes('downtime')) {
      answer  = `⏱ Availability — ${timeLabel}: **${f1(avail_pct)}%**\n\n`;
      answer += `• Running  : ${fi(running_sec/60)} min\n• Downtime : ${fi(down_sec/60)} min\n• Net avail: ${fi(net_avail/60)} min`;
      sql_ref = `SELECT time, machine_state, is_running FROM cnc_data WHERE machine_id='MACHINE001' AND time >= '${fromTime.toISOString()}'`;
    } else if (q.includes('perform')) {
      answer  = `⚡ Performance — ${timeLabel}: **${f1(perf_pct)}%**\n\n`;
      answer += `• Parts: ${parts} pcs | Avg cycle: ${avgCycle>0?f1(avgCycle):'N/A'}s | Best: ${minCycle>0?f1(minCycle):'N/A'}s`;
      sql_ref = `SELECT part_count, last_cycle_time_sec FROM cnc_data WHERE machine_id='MACHINE001' AND time >= '${fromTime.toISOString()}'`;
    } else if (q.match(/part|produc/)) {
      const firstCount = pCounts.length ? Math.min(...pCounts) : 0;
      const lastCount  = pCounts.length ? Math.max(...pCounts) : 0;
      const pFrom = fmtT(rows[0].time), pTo = fmtT(rows[rows.length-1].time);
      const proRate = elapsed > 0 ? (parts / (elapsed/3600)).toFixed(0) : 0;
      answer  = `🏭 Parts — ${timeLabel}: **${parts} pcs**\n\n`;
      answer += `• From ${pFrom} → ${pTo}\n`;
      answer += `• Counter start : ${firstCount} → end : ${lastCount}\n`;
      answer += `• Production rate : ~${proRate} pcs/hr\n`;
      answer += `• Readings analyzed : ${rows.length} rows`;
      sql_ref = `SELECT MAX(part_count)-MIN(part_count) AS parts_made\nFROM cnc_data\nWHERE machine_id='MACHINE001' AND time >= '${fromTime.toISOString()}'`;
    } else if (q.match(/alarm|error|fault/)) {
      answer = alarmRows.length
        ? `🚨 Alarms — ${timeLabel}: ${alarmRows.length} alarm readings\n\nCodes: ${alarmNos.join(', ')||'various'}\nFirst: ${fmtT(alarmRows[0].time)} | Last: ${fmtT(alarmRows[alarmRows.length-1].time)}`
        : `✅ No alarms in ${timeLabel}. Machine running clean.`;
      sql_ref = `SELECT time, alarm_no FROM cnc_data WHERE machine_id='MACHINE001' AND alarm_active=true AND time >= '${fromTime.toISOString()}'`;
    } else if (q.match(/cycle|cycle.?time/)) {
      answer  = `⏱ Cycle Time — ${timeLabel}:\n\n• Last: ${f1(lastRow.last_cycle_time_sec||0)}s | Avg: ${avgCycle>0?f1(avgCycle):'N/A'}s | Best: ${minCycle>0?f1(minCycle):'N/A'}s | Target: 45s`;
      if(avgCycle>0) answer += `\n• Cycle efficiency: ${f1(45/avgCycle*100)}%`;
      sql_ref = `SELECT time, last_cycle_time_sec FROM cnc_data WHERE machine_id='MACHINE001' AND time >= '${fromTime.toISOString()}'`;
    } else if (q.match(/spindle|rpm/)) {
      answer  = `🔄 Spindle — ${timeLabel}:\n\n• Current: ${lastRow.spindle_speed||'—'} RPM | Avg: ${fi(avgSpin)} RPM`;
      sql_ref = `SELECT time, spindle_speed FROM cnc_data WHERE machine_id='MACHINE001' AND time >= '${fromTime.toISOString()}'`;
    } else if (q.match(/feed|mm.min/)) {
      answer  = `📏 Feed Rate — ${timeLabel}:\n\n• Current: ${lastRow.feed_rate||'—'} mm/min | Avg: ${fi(avgFeed)} mm/min`;
      sql_ref = `SELECT time, feed_rate FROM cnc_data WHERE machine_id='MACHINE001' AND time >= '${fromTime.toISOString()}'`;
    } else if (q.match(/status|state|running|now|current/)) {
      const stMap={};rows.forEach(rr=>{const s=rr.machine_state||'UNKNOWN';stMap[s]=(stMap[s]||0)+1;});
      const stStr=Object.entries(stMap).map(([k,v])=>`  ${k}: ${v} (${(v/rows.length*100).toFixed(0)}%)`).join('\n');
      answer  = `⚙️ Machine Status — ${timeLabel}:\n\n• State: ${lastRow.machine_state||'—'} | Running: ${lastRow.is_running?'✅ YES':'❌ NO'} | At: ${fmtT(lastRow.time)}\n\nDistribution:\n${stStr}`;
      sql_ref = `SELECT machine_state, COUNT(*) FROM cnc_data WHERE machine_id='MACHINE001' AND time >= '${fromTime.toISOString()}' GROUP BY machine_state`;
    } else {
      answer  = `📋 KPI Summary — ${timeLabel}\n${'─'.repeat(30)}\n`;
      answer += `🎯 OEE: ${f1(oee_pct)}% | ✅ Avail: ${f1(avail_pct)}% | ⚡ Perf: ${f1(perf_pct)}%\n`;
      answer += `🏭 Parts: ${parts}/${TARGET_PARTS} (${(parts/TARGET_PARTS*100).toFixed(0)}%) | ⏱ Cycle: ${avgCycle>0?f1(avgCycle):'N/A'}s\n`;
      answer += `🚨 Alarms: ${alarmRows.length} | 📊 Readings: ${rows.length}\n\n`;
      answer += `💡 Try: "OEE today", "alarms this shift", "parts last 2 hours", "cycle time now"`;
      sql_ref = `SELECT time, machine_state, part_count, last_cycle_time_sec, spindle_speed FROM cnc_data\nWHERE machine_id='MACHINE001' AND time >= '${fromTime.toISOString()}'`;
    }

    res.json({ ok:true, answer, sql_ref, time_range:timeLabel,
      rows_analyzed:rows.length, engine:'rule-machine001' });
  } catch(e) {
    console.error('[Facto-Bot]', e.message);
    res.status(500).json({ ok:false, error:e.message,
      answer:`❌ Error: ${e.message}\n\nTry rephrasing or check if Node-RED is writing to cnc_data.` });
  }
});

// ── CNC: Ensure new tables exist ─────────────────────────────────
async function ensureCNCTables() {
  const client = await dbCNC.connect();
  try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS program_master (
      program_no    INTEGER PRIMARY KEY,
      part_name     TEXT    NOT NULL,
      part_number   TEXT,
      target_cycle_sec NUMERIC(8,2) DEFAULT 44,
      material      TEXT,
      machine_id    TEXT DEFAULT 'MACHINE001',
      description   TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cnc_downtime_log (
      id            BIGSERIAL PRIMARY KEY,
      machine_id    TEXT DEFAULT 'MACHINE001',
      shift_date    DATE NOT NULL,
      shift         CHAR(1) NOT NULL,
      start_time    TIMESTAMPTZ NOT NULL,
      end_time      TIMESTAMPTZ,
      duration_min  NUMERIC(8,2),
      type          TEXT CHECK(type IN ('PLANNED','UNPLANNED')),
      reason_code   TEXT,
      reason_detail TEXT,
      operator_name TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cnc_rejection_log (
      id            BIGSERIAL PRIMARY KEY,
      machine_id    TEXT DEFAULT 'MACHINE001',
      shift_date    DATE NOT NULL,
      shift         CHAR(1) NOT NULL,
      log_hour      INTEGER,
      program_no    INTEGER,
      good_parts    INTEGER DEFAULT 0,
      rejected_parts INTEGER DEFAULT 0,
      rejection_reason TEXT,
      operator_name TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cnc_shift_log (
      id            BIGSERIAL PRIMARY KEY,
      machine_id    TEXT DEFAULT 'MACHINE001',
      shift_date    DATE NOT NULL,
      shift         CHAR(1) NOT NULL,
      operator_name TEXT,
      supervisor    TEXT,
      program_no    INTEGER,
      target_parts  INTEGER DEFAULT 920,
      notes         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(machine_id, shift_date, shift)
    );
  `);
  // ── Upgrade cnc_downtime_log with severity/action/assign fields ─
  const dtUpgrades = [
    `ALTER TABLE cnc_downtime_log ADD COLUMN IF NOT EXISTS severity TEXT DEFAULT 'MINOR'`,
    `ALTER TABLE cnc_downtime_log ADD COLUMN IF NOT EXISTS action_to_take TEXT`,
    `ALTER TABLE cnc_downtime_log ADD COLUMN IF NOT EXISTS assigned_to TEXT`,
    `ALTER TABLE cnc_downtime_log ADD COLUMN IF NOT EXISTS assigned_email TEXT`,
  ];
  for (const q of dtUpgrades) {
    try { await client.query(q); } catch(e) { /* column may already exist */ }
  }
  // ── cnc_downtime_rca table — auto-detected events + RCA workflow ──
  await client.query(`
    CREATE TABLE IF NOT EXISTS cnc_downtime_rca (
      id                  BIGSERIAL PRIMARY KEY,
      machine_id          TEXT NOT NULL DEFAULT 'MACHINE001',
      shift_date          DATE NOT NULL,
      shift               CHAR(1) NOT NULL,
      start_time          TIMESTAMPTZ NOT NULL,
      end_time            TIMESTAMPTZ,
      duration_sec        NUMERIC(10,1),
      duration_min        NUMERIC(8,2),
      severity            TEXT CHECK (severity IN ('MINOR','MEDIUM','MAJOR')),
      state               TEXT,
      alarm_no            TEXT,
      -- RCA chain
      downtime_category   TEXT,
      why1                TEXT,
      why2                TEXT,
      why3                TEXT,
      why4                TEXT,
      why5                TEXT,
      immediate_action    TEXT,
      corrective_action   TEXT,
      preventive_action   TEXT,
      responsible_person  TEXT,
      target_date         DATE,
      closure_date        DATE,
      rca_status          TEXT DEFAULT 'OPEN' CHECK (rca_status IN ('OPEN','IN_PROGRESS','CLOSED')),
      rca_notes           TEXT,
      updated_by          TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (machine_id, start_time)
    );
  `).catch(() => {});
  // ── Upgrade cnc_rejection_log with action/assign fields ──────────
  const rjUpgrades = [
    `ALTER TABLE cnc_rejection_log ADD COLUMN IF NOT EXISTS defect_type TEXT`,
    `ALTER TABLE cnc_rejection_log ADD COLUMN IF NOT EXISTS severity TEXT DEFAULT 'MINOR'`,
    `ALTER TABLE cnc_rejection_log ADD COLUMN IF NOT EXISTS action_to_take TEXT`,
    `ALTER TABLE cnc_rejection_log ADD COLUMN IF NOT EXISTS assigned_to TEXT`,
    `ALTER TABLE cnc_rejection_log ADD COLUMN IF NOT EXISTS assigned_email TEXT`,
    `ALTER TABLE cnc_rejection_log ADD COLUMN IF NOT EXISTS program_no_ref INTEGER`,
  ];
  for (const q of rjUpgrades) {
    try { await client.query(q); } catch(e) { /* column may already exist */ }
  }
  // ── Seed Demo Machine Hobbing Machine (896) program master data ─────────
  const PROG_SEED = [
    [1,  'STD',                     'O0001',       null, 'Development | Standard Setup Program'],
    [2,  'F8A02611 — 20T',          'F8A02611',    128,  'Regular | 20 Teeth'],
    [3,  'FM008711 — 44T',          'FM008711',    null, 'Development | 44 Teeth'],
    [4,  'FM000210 — 34T',          'FM000210',    null, 'Development | 34 Teeth'],
    [5,  'FVJ00511 — 35T',          'FVJ00511',    200,  'Regular | 35 Teeth'],
    [6,  'FM006111 — 43T',          'FM006111',    245,  'Regular | 43 Teeth'],
    [7,  'F8A02611 — 20T (1st Op)', 'F8A02611-1S', 150,  'Regular | 20 Teeth 1st Setup'],
    [8,  'DH102208 — 66T',          'DH102208',    36,   'Regular | 66 Teeth'],
    [9,  'AZ551213 — 41T',          'AZ551213',    45,   'Regular | 41 Teeth'],
    [10, 'F1614811 — 35T',          'F1614811',    200,  'Regular | 35 Teeth'],
    [11, 'F165111 — 36T',           'F165111',     255,  'Regular | 36 Teeth'],
    [12, 'ACAOIC00230 — 36T',       'ACAOIC00230', null, 'Development | 36 Teeth'],
    [13, 'D10535980 — 25T',         'D10535980',   120,  'Regular | 25 Teeth'],
    [14, 'E23542 — 61T',            'E23542',      null, 'Development | 61 Teeth'],
    [15, 'GEAR SUN — 23T',          'GEAR_SUN',    null, 'Development | 23 Teeth Sun Gear'],
    [16, 'FM00611 — 43T',           'FM00611',     245,  'Regular | 43 Teeth'],
  ];
  for (const [no, name, pno, cyc, desc] of PROG_SEED) {
    try {
      await client.query(
        `INSERT INTO program_master(program_no,part_name,part_number,target_cycle_sec,machine_id,description,updated_at)
         VALUES($1,$2,$3,$4,'MACHINE001',$5,NOW())
         ON CONFLICT(program_no) DO UPDATE SET
           part_name=EXCLUDED.part_name, part_number=EXCLUDED.part_number,
           target_cycle_sec=EXCLUDED.target_cycle_sec, machine_id=EXCLUDED.machine_id,
           description=EXCLUDED.description, updated_at=NOW()`,
        [no, name, pno, cyc, desc]
      );
    } catch(e) { console.warn(`[ProgramSeed] O${String(no).padStart(4,'0')}: ${e.message}`); }
  }
  console.log('✅ CNC tables ensured');
  console.log('✅ Program master seeded (16 Demo Machine Hobbing programs)');
  } finally { client.release(); }
}
ensureCNCTables().catch(e => console.error('CNC table setup:', e.message));

// ── Deploy OEE SQL functions & views to cnc_db ────────────────────
async function deployOEEFunctions() {
  const client = await dbCNC.connect();
  try {
    const sqlPath = path.join(__dirname, 'sql', 'oee_functions.sql');
    if (!fs.existsSync(sqlPath)) {
      console.warn('⚠️  sql/oee_functions.sql not found — skipping OEE function deploy');
      return;
    }
    let sql = fs.readFileSync(sqlPath, 'utf8');
    sql = sql.replace(/--.*\n/g, '\n');
    await client.query(sql);
    console.log('✅ OEE SQL functions & views deployed → cnc_db');
    await client.query(`SELECT refresh_oee_summary(CURRENT_DATE)`);
    console.log('✅ oee_summary refreshed for today');
  } catch(e) {
    console.error('⚠️  OEE function deploy error:', e.message);
  } finally { client.release(); }
}

// ── Deploy oee_results table + populate functions ─────────────────
async function deployOEEResultsTable() {
  const client = await dbCNC.connect();
  try {
    const sqlPath = path.join(__dirname, 'sql', 'oee_results_table.sql');
    if (!fs.existsSync(sqlPath)) {
      console.warn('⚠️  sql/oee_results_table.sql not found — skipping oee_results deploy');
      return;
    }
    let sql = fs.readFileSync(sqlPath, 'utf8');
    sql = sql.replace(/--.*\n/g, '\n');
    await client.query(sql);
    console.log('✅ oee_results table + functions deployed → cnc_db');
    await client.query(`SELECT populate_oee_today()`);
    console.log('✅ oee_results populated for today');
  } catch(e) {
    console.error('⚠️  oee_results deploy error:', e.message);
  } finally { client.release(); }
}

async function deployRebuildTables() {
  const client = await dbCNC.connect();
  try {
    const sqlPath = path.join(__dirname, 'sql', 'REBUILD_ALL_TABLES.sql');
    if (!fs.existsSync(sqlPath)) {
      console.log('ℹ️  REBUILD_ALL_TABLES.sql not found — skipping full rebuild');
      return;
    }
    let sql = fs.readFileSync(sqlPath, 'utf8');
    // Remove comment lines to avoid psql-specific syntax issues
    sql = sql.replace(/^--.*$/gm, '').replace(/\\c\s+\w+/g, '').trim();
    await client.query(sql);
    console.log('✅ REBUILD_ALL_TABLES.sql deployed → cnc_db');
  } catch(e) {
    // Non-fatal — tables may already exist
    console.warn('⚠️  deployRebuildTables (non-fatal):', e.message.slice(0, 200));
  } finally { client.release(); }
}

deployRebuildTables()
  .then(() => deployOEEFunctions())
  .then(() => deployOEEResultsTable())
  .catch(e => console.error('⚠️  OEE deploy chain error:', e.message));

// ══════════════════════════════════════════════════════════════════
//  THINGSBOARD PE — OEE telemetry push
//  Runs every 5 min after populate_oee_today() — no Node-RED needed
// ══════════════════════════════════════════════════════════════════
async function pushOEEToThingsBoard() {
  try {
    // Determine the correct shift_date for the CURRENT shift.
    // Shift A: 07:00–19:00 IST  → shift_date = today
    // Shift B: 19:00–07:00 IST  → shift_date = the day Shift B STARTED
    //   • 19:00–23:59 IST: started today          → shift_date = today
    //   • 00:00–06:59 IST: started YESTERDAY 19:00 → shift_date = yesterday
    const istNow  = new Date(Date.now() + 5.5 * 3600 * 1000); // approx IST
    const istHour = istNow.getUTCHours(); // hours in the IST-shifted clock
    let shiftDate;
    if (istHour < 7) {
      // 00:00–06:59 IST → still in Shift B that started yesterday
      const prev = new Date(istNow);
      prev.setUTCDate(prev.getUTCDate() - 1);
      shiftDate = prev.toISOString().slice(0, 10);
    } else {
      shiftDate = istNow.toISOString().slice(0, 10);
    }

    // Pull all shifts for today from oee_results
    const r = await dbCNC.query(`
      SELECT
        shift,
        ROUND(oee::numeric,          1) AS oee,
        ROUND(availability::numeric, 1) AS availability,
        ROUND(performance::numeric,  1) AS performance,
        ROUND(quality::numeric,      1) AS quality,
        COALESCE(parts_produced,     0) AS parts_produced,
        COALESCE(target_parts,       0) AS target_parts,
        COALESCE(good_parts, parts_produced, 0) AS good_parts,
        COALESCE(rejection_count,    0) AS rejection_count,
        COALESCE(parts_attainment,   0) AS attainment_pct,
        COALESCE(cycle_efficiency,   0) AS cycle_efficiency,
        COALESCE(running_min,        0) AS running_min,
        COALESCE(downtime_min,       0) AS downtime_min,
        COALESCE(alarm_count,        0) AS alarm_count,
        COALESCE(avg_cycle_sec,      0) AS avg_cycle_sec,
        COALESCE(target_cycle_sec,  45) AS target_cycle_sec
      FROM oee_results
      WHERE machine_id = $1 AND shift_date = $2
      ORDER BY shift
    `, [TB_MACHINE, shiftDate]);

    if (!r.rows.length) {
      console.log(`[TB] No OEE rows for shift_date=${shiftDate}, skipping push`);
      return;
    }

    // Build flat telemetry payload
    const payload = {};
    let sumParts = 0, sumTarget = 0, sumGood = 0, sumRej = 0;
    let sumOEE = 0, sumAvail = 0, sumPerf = 0, sumQual = 0, n = 0;

    for (const row of r.rows) {
      const s = row.shift.toLowerCase(); // 'a' or 'b'
      payload[`oee_shift_${s}`]          = +parseFloat(row.oee          || 0).toFixed(1);
      payload[`availability_shift_${s}`] = +parseFloat(row.availability || 0).toFixed(1);
      payload[`performance_shift_${s}`]  = +parseFloat(row.performance  || 0).toFixed(1);
      payload[`quality_shift_${s}`]      = +parseFloat(row.quality      || 0).toFixed(1);
      payload[`parts_shift_${s}`]        = parseInt(row.parts_produced)  || 0;
      payload[`target_shift_${s}`]       = parseInt(row.target_parts)    || 0;
      payload[`good_parts_shift_${s}`]   = parseInt(row.good_parts)      || 0;
      payload[`rejections_shift_${s}`]   = parseInt(row.rejection_count) || 0;
      payload[`cycle_eff_shift_${s}`]    = +parseFloat(row.cycle_efficiency || 0).toFixed(1);
      payload[`running_min_shift_${s}`]  = +parseFloat(row.running_min   || 0).toFixed(1);
      payload[`downtime_min_shift_${s}`] = +parseFloat(row.downtime_min  || 0).toFixed(1);
      payload[`alarms_shift_${s}`]       = parseInt(row.alarm_count)     || 0;
      payload[`avg_cycle_shift_${s}`]    = +parseFloat(row.avg_cycle_sec || 0).toFixed(1);
      payload[`target_cycle_shift_${s}`] = +parseFloat(row.target_cycle_sec || 45).toFixed(1);

      const runMin = parseFloat(row.running_min || 0);
      // Always sum production counts from every shift row
      sumParts  += parseInt(row.parts_produced)  || 0;
      sumTarget += parseInt(row.target_parts)    || 0;
      sumGood   += parseInt(row.good_parts)      || 0;
      sumRej    += parseInt(row.rejection_count) || 0;
      // Weighted average for OEE % — weight by running minutes
      // Shifts with 0 running minutes contribute 0 weight (no divide-by-zero)
      if (runMin > 0) {
        sumOEE    += parseFloat(row.oee          || 0) * runMin;
        sumAvail  += parseFloat(row.availability || 0) * runMin;
        sumPerf   += parseFloat(row.performance  || 0) * runMin;
        sumQual   += parseFloat(row.quality      || 0) * runMin;
        n         += runMin;
      }
    }

    // Daily totals — weighted average OEE matches what dashboard shows
    payload['parts_today']        = sumParts;
    payload['target_today']       = sumTarget;
    payload['good_parts_today']   = sumGood;
    payload['rejections_today']   = sumRej;
    payload['oee_today']          = n > 0 ? +((sumOEE   / n).toFixed(1)) : 0;
    payload['availability_today'] = n > 0 ? +((sumAvail / n).toFixed(1)) : 0;
    payload['performance_today']  = n > 0 ? +((sumPerf  / n).toFixed(1)) : 0;
    payload['quality_today']      = n > 0 ? +((sumQual  / n).toFixed(1)) : 0;

    // POST to ThingsBoard PE REST telemetry endpoint
    const resp = await fetch(TB_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      timeout: 8000,
    });

    if (resp.ok) {
      console.log(`[TB] ✅ OEE pushed → ${Object.keys(payload).length} keys | oee_today=${payload.oee_today}% | parts=${payload.parts_today}/${payload.target_today}`);
    } else {
      const body = await resp.text().catch(() => '');
      console.warn(`[TB] ⚠️  Push HTTP ${resp.status}: ${body.slice(0, 120)}`);
    }
  } catch (e) {
    console.error('[TB] pushOEEToThingsBoard error:', e.message);
  }
}

// ── Auto-refresh oee_results every 5 minutes ─────────────────────
setInterval(async () => {
  try {
    await dbCNC.query(`SELECT populate_oee_today()`);
    console.log('[OEE] oee_results refreshed at', new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }));
    // Push computed OEE to ThingsBoard PE after every refresh
    pushOEEToThingsBoard();
  } catch(e) {
    console.error('[OEE] auto-refresh error:', e.message);
  }
}, 5 * 60 * 1000);

// ══════════════════════════════════════════════════════════════════
//  SHIFT REPORT — Auto email at shift end (07:05 and 19:05 IST)
//  Shift A: 07:00–19:00  |  Shift B: 19:00–07:00
//  Recipients: ops@factory-mios.local, ops@factory-mios.local
// ══════════════════════════════════════════════════════════════════
const SHIFT_REPORT_TO = [
  'ops@factory-mios.local',
  'ops@factory-mios.local'
];

async function buildShiftReport(shift, shiftDate) {
  // shift = 'A' or 'B', shiftDate = 'YYYY-MM-DD' (the date the shift STARTED on)
  const machine = 'MACHINE001';

  // Shift time boundaries (UTC = IST - 5:30)
  let shiftStartUTC, shiftEndUTC;
  if (shift === 'A') {
    // Shift A: 07:00–19:00 IST on shiftDate
    shiftStartUTC = new Date(shiftDate + 'T01:30:00Z'); // 07:00 IST = 01:30 UTC
    shiftEndUTC   = new Date(shiftDate + 'T13:30:00Z'); // 19:00 IST = 13:30 UTC
  } else {
    // Shift B: 19:00 IST on shiftDate to 07:00 IST on shiftDate+1
    shiftStartUTC = new Date(shiftDate + 'T13:30:00Z'); // 19:00 IST = 13:30 UTC
    const nextDay = new Date(shiftDate); nextDay.setDate(nextDay.getDate() + 1);
    const nextISO = nextDay.toISOString().slice(0, 10);
    shiftEndUTC   = new Date(nextISO + 'T01:30:00Z');   // 07:00 IST next day
  }

  // 1. OEE row from oee_results
  const oeeRow = await dbCNC.query(`
    SELECT * FROM oee_results
    WHERE machine_id=$1 AND shift_date=$2 AND shift=$3
    LIMIT 1`, [machine, shiftDate, shift]);
  const o = oeeRow.rows[0] || {};

  // 2. Programs run during this shift (from cnc_data)
  // program_no is integer — use IS NOT NULL only, no text comparison
  const progRes = await dbCNC.query(`
    SELECT
      cd.program_no::text AS program_no,
      COALESCE(pm.part_name, 'Program ' || cd.program_no::text) AS part_name,
      COUNT(*) FILTER (WHERE last_cycle_time_sec > 0) AS parts_made,
      ROUND(AVG(last_cycle_time_sec) FILTER (
        WHERE last_cycle_time_sec BETWEEN 5 AND 3600)::numeric, 1) AS avg_cycle
    FROM cnc_data cd
    LEFT JOIN program_master pm ON pm.program_no::text = cd.program_no::text
    WHERE cd.machine_id=$1
      AND cd.time >= $2 AND cd.time < $3
      AND cd.program_no IS NOT NULL
    GROUP BY cd.program_no, pm.part_name
    ORDER BY parts_made DESC
    LIMIT 10`, [machine, shiftStartUTC, shiftEndUTC]);

  // 3. Downtime events from cnc_downtime_log (if table exists)
  let dtEvents = [];
  try {
    const dtRes = await dbCNC.query(`
      SELECT reason, COALESCE(duration_min, ROUND(EXTRACT(EPOCH FROM (end_time - start_time))/60)::int, 0) AS duration_min,
             TO_CHAR(start_time AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS start_time
      FROM cnc_downtime_log
      WHERE machine_id=$1 AND shift_date=$2 AND shift=$3
      ORDER BY duration_min DESC NULLS LAST
      LIMIT 8`, [machine, shiftDate, shift]);
    dtEvents = dtRes.rows;
  } catch(_) {
    // Table may not exist yet — derive from cnc_data state changes
    try {
      const dtFallback = await dbCNC.query(`
        SELECT machine_state AS reason,
               COUNT(*) * 5 / 60 AS duration_min,
               MIN(TO_CHAR(time AT TIME ZONE 'Asia/Kolkata', 'HH24:MI')) AS start_time
        FROM cnc_data
        WHERE machine_id=$1 AND time >= $2 AND time < $3
          AND UPPER(COALESCE(machine_state,'')) NOT IN ('RUNNING','AUTO','BUSY')
          AND machine_state IS NOT NULL AND machine_state <> ''
        GROUP BY machine_state
        ORDER BY duration_min DESC
        LIMIT 6`, [machine, shiftStartUTC, shiftEndUTC]);
      dtEvents = dtFallback.rows;
    } catch(__) {}
  }

  const shiftLabels = { A: 'Shift A  (07:00 – 19:00 IST)', B: 'Shift B  (19:00 – 07:00 IST)' };

  return {
    shift,
    shiftDate,
    shiftLabel:    shiftLabels[shift],
    machineId:     machine,
    oee:           o.oee            || 0,
    availability:  o.availability   || 0,
    performance:   o.performance    || 0,
    quality:       o.quality        || 0,
    attainment:    o.parts_attainment|| 0,
    partsProd:     o.parts_produced || 0,
    targetParts:   o.target_parts   || 0,
    goodParts:     o.good_parts     || 0,
    rejections:    o.rejection_count|| 0,
    rejectRate:    o.scrap_rate     || 0,
    runningMin:    o.running_min    || 0,
    downtimeMin:   o.downtime_min   || 0,
    majorDownMin:  o.major_downtime_min || 0,
    minorDownMin:  o.minor_downtime_min || 0,
    avgCycleSec:   o.avg_cycle_sec  || 0,
    targetCycleSec:o.target_cycle_sec|| 45,
    bestCycleSec:  o.best_cycle_sec || 0,
    worstCycleSec: o.worst_cycle_sec|| 0,
    cycleEff:      o.cycle_efficiency|| 0,
    alarmCount:    o.alarm_count    || 0,
    programs:      progRes.rows,
    downtimeEvents: dtEvents,
  };
}

async function sendShiftEndReport(shift, shiftDate) {
  const store = loadAlertStore();
  if (!store.smtp || !store.smtp.host) {
    console.warn('[ShiftReport] SMTP not configured — skipping email. Configure via Alerts → Settings.');
    return;
  }
  try {
    await dbCNC.query(`SELECT populate_oee_today()`);
  } catch(_) {}
  try {
    const { sendShiftReportEmail } = require('./lib/mailer');
    const report = await buildShiftReport(shift, shiftDate);
    await sendShiftReportEmail({
      smtp: store.smtp,
      to:   SHIFT_REPORT_TO,
      report,
    });
    console.log(`[ShiftReport] ✅ Shift ${shift} report sent for ${shiftDate}`);
  } catch(e) {
    console.error('[ShiftReport] Error sending report:', e.message);
  }
}

// ── Shift-end scheduler: checks every minute for 07:05 and 19:05 IST ──
let lastShiftReportSent = '';  // prevents double-fire within same minute
setInterval(() => {
  const now = new Date();
  const istHour = parseInt(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(now));
  const istMin  = parseInt(new Intl.DateTimeFormat('en-IN', { minute: 'numeric', timeZone: 'Asia/Kolkata' }).format(now));
  const istDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now); // YYYY-MM-DD

  // 07:05 IST → send Shift B report (B ran 19:00 previous day → 07:00 today)
  if (istHour === 7 && istMin === 5) {
    const key = `B-${istDate}`;
    if (lastShiftReportSent !== key) {
      lastShiftReportSent = key;
      // Shift B date = yesterday (shift started at 19:00 previous IST day)
      const prev = new Date(now);
      prev.setDate(prev.getDate() - 1);
      const prevDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(prev);
      console.log(`[ShiftReport] Triggering Shift B report for ${prevDate}…`);
      sendShiftEndReport('B', prevDate);
    }
  }

  // 19:05 IST → send Shift A report (A ran 07:00–19:00 today)
  if (istHour === 19 && istMin === 5) {
    const key = `A-${istDate}`;
    if (lastShiftReportSent !== key) {
      lastShiftReportSent = key;
      console.log(`[ShiftReport] Triggering Shift A report for ${istDate}…`);
      sendShiftEndReport('A', istDate);
    }
  }
}, 60 * 1000); // check every minute

// ── Mobile PWA ────────────────────────────────────────────────────
app.get('/mobile', (req,res) => res.sendFile(path.join(__dirname,'public','mobile.html')));
app.get('/sw.js',  (req,res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname,'public','sw.js'));
});

// ── CNC Pages ─────────────────────────────────────────────────────
app.get('/program-master',    pageAuth, (req,res) => res.sendFile(path.join(__dirname,'public','program-master.html')));
app.get('/downtime-log',      pageAuth, (req,res) => res.sendFile(path.join(__dirname,'public','downtime-log.html')));
app.get('/rejection-log',     pageAuth, (req,res) => res.sendFile(path.join(__dirname,'public','rejection-log.html')));
app.get('/shift-input',       pageAuth, (req,res) => res.sendFile(path.join(__dirname,'public','shift-input.html')));
app.get('/machine-live',      pageAuth, (req,res) => res.sendFile(path.join(__dirname,'public','machine-live.html')));
app.get('/parameter-report',  pageAuth, (req,res) => res.sendFile(path.join(__dirname,'public','parameter-report.html')));

// ── Program Master API ────────────────────────────────────────────
app.get('/api/cnc/programs', async (req,res) => {
  try { const r = await dbCNC.query('SELECT * FROM program_master ORDER BY program_no'); res.json({ok:true,data:r.rows}); }
  catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/cnc/programs', async (req,res) => {
  try {
    const {program_no,part_name,part_number,target_cycle_sec,material,description} = req.body;
    await dbCNC.query(
      `INSERT INTO program_master(program_no,part_name,part_number,target_cycle_sec,material,description)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(program_no) DO UPDATE SET
       part_name=$2,part_number=$3,target_cycle_sec=$4,material=$5,description=$6,updated_at=NOW()`,
      [program_no,part_name,part_number||null,target_cycle_sec||44,material||null,description||null]
    );
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.delete('/api/cnc/programs/:id', async (req,res) => {
  try { await dbCNC.query('DELETE FROM program_master WHERE program_no=$1',[req.params.id]); res.json({ok:true}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// ── Downtime Log API ──────────────────────────────────────────────
app.get('/api/cnc/downtime', async (req,res) => {
  try {
    const {date,shift} = req.query;
    const from = date || new Date().toISOString().slice(0,10);
    const r = await dbCNC.query(
      `SELECT * FROM cnc_downtime_log WHERE shift_date=$1 ${shift?'AND shift=$2':''} ORDER BY start_time DESC`,
      shift?[from,shift]:[from]
    );
    res.json({ok:true,data:r.rows});
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/cnc/downtime', async (req,res) => {
  try {
    const {shift_date,shift,start_time,end_time,duration_min,type,reason_code,reason_detail,operator_name} = req.body;
    await dbCNC.query(
      `INSERT INTO cnc_downtime_log(shift_date,shift,start_time,end_time,duration_min,type,reason_code,reason_detail,operator_name)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [shift_date,shift,start_time,end_time||null,duration_min||null,type,reason_code||null,reason_detail||null,operator_name||null]
    );
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.delete('/api/cnc/downtime/:id', async (req,res) => {
  try { await dbCNC.query('DELETE FROM cnc_downtime_log WHERE id=$1',[req.params.id]); res.json({ok:true}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// ── Rejection Log API ─────────────────────────────────────────────
app.get('/api/cnc/rejections', async (req,res) => {
  try {
    const {date,shift} = req.query;
    const from = date || new Date().toISOString().slice(0,10);
    const r = await dbCNC.query(
      `SELECT r.*, p.part_name FROM cnc_rejection_log r
       LEFT JOIN program_master p ON p.program_no=r.program_no
       WHERE shift_date=$1 ${shift?'AND shift=$2':''}
       ORDER BY created_at DESC`,
      shift?[from,shift]:[from]
    );
    res.json({ok:true,data:r.rows});
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/cnc/rejections', async (req,res) => {
  try {
    const {shift_date,shift,log_hour,program_no,good_parts,rejected_parts,rejection_reason,operator_name} = req.body;
    await dbCNC.query(
      `INSERT INTO cnc_rejection_log(shift_date,shift,log_hour,program_no,good_parts,rejected_parts,rejection_reason,operator_name)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [shift_date,shift,log_hour||null,program_no||null,good_parts||0,rejected_parts||0,rejection_reason||null,operator_name||null]
    );
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.delete('/api/cnc/rejections/:id', async (req,res) => {
  try { await dbCNC.query('DELETE FROM cnc_rejection_log WHERE id=$1',[req.params.id]); res.json({ok:true}); }
  catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/api/cnc/rejection-trend', async (req,res) => {
  try {
    const {date,shift} = req.query;
    const from = date || new Date().toISOString().slice(0,10);
    const r = await dbCNC.query(
      `SELECT log_hour, SUM(good_parts) AS good, SUM(rejected_parts) AS rejected,
              CASE WHEN SUM(good_parts+rejected_parts)>0
                THEN ROUND(SUM(rejected_parts)::numeric/SUM(good_parts+rejected_parts)*100,2) ELSE 0 END AS rejection_pct
       FROM cnc_rejection_log WHERE shift_date=$1 ${shift?'AND shift=$2':''}
       GROUP BY log_hour ORDER BY log_hour`,
      shift?[from,shift]:[from]
    );
    res.json({ok:true,data:r.rows});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── Alias routes: downtime-log → downtime, rejection-log → rejections ──
// These match the URL patterns used by downtime-log.html and rejection-log.html
app.get('/api/cnc/downtime-log', async (req,res) => {
  try {
    const { date, shift, machine, limit } = req.query;
    const from = date || new Date().toISOString().slice(0,10);
    const lim  = parseInt(limit) || 500;
    const r = await dbCNC.query(
      `SELECT * FROM cnc_downtime_log
       WHERE shift_date >= ($1::date - INTERVAL '30 days')
       ${date  ? 'AND shift_date = $1::date' : ''}
       ${shift && shift !== 'Both' ? `AND shift = '${shift.replace(/'/g,"''")}'` : ''}
       ORDER BY shift_date DESC, start_time DESC LIMIT $2`,
      [from, lim]
    );
    res.json({ ok:true, data:r.rows });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});
app.post('/api/cnc/downtime-log', async (req,res) => {
  try {
    const {shift_date,shift,start_time,end_time,duration_min,type,reason_code,reason_detail,
           operator_name,severity,action_to_take,assigned_to,assigned_email} = req.body;
    const dur = parseFloat(duration_min) || 0;
    const sev = dur < 1 ? 'MINOR' : dur < 10 ? 'SECOND_LEVEL' : 'MAJOR';
    await dbCNC.query(
      `INSERT INTO cnc_downtime_log(shift_date,shift,start_time,end_time,duration_min,type,reason_code,reason_detail,
         operator_name,severity,action_to_take,assigned_to,assigned_email)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [shift_date,shift,start_time,end_time||null,dur||null,type||'UNPLANNED',reason_code||null,reason_detail||null,
       operator_name||null,sev,action_to_take||null,assigned_to||null,assigned_email||null]
    );
    // ── Email alert for MAJOR downtime (>10 min) ────────────────
    if (sev === 'MAJOR' && assigned_email) {
      try {
        const store = loadAlertStore();
        if (store.smtp && store.smtp.host) {
          const { sendAlertEmail } = require('./lib/mailer');
          await sendAlertEmail({
            smtp: store.smtp,
            to:   assigned_email,
            subject: `🚨 MAJOR DOWNTIME ALERT — ${dur} min | ${reason_code || 'Unspecified'}`,
            rule:  { name: 'Major Downtime', condition: 'gt', threshold: 10, severity: 'critical' },
            value: `${dur} min downtime on ${shift_date} Shift ${shift}`,
            liveData: { machine_id:'MACHINE001', operator_name, reason_code, reason_detail,
                        action_to_take, assigned_to, shift_date, shift }
          });
        }
      } catch(mailErr) { console.warn('[Downtime] Email failed:', mailErr.message); }
    }
    res.json({ ok:true, severity: sev });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});
app.delete('/api/cnc/downtime-log/:id', async (req,res) => {
  try { await dbCNC.query('DELETE FROM cnc_downtime_log WHERE id=$1',[req.params.id]); res.json({ok:true}); }
  catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// MACHINES LIST — all known machines (SaaS registry + cnc_data)
// ══════════════════════════════════════════════════════════════════════
// GET /api/cnc/machines-list
// Returns all machines with plant info, used by quality/downtime dropdowns
app.get('/api/cnc/machines-list', authMiddleware, async (req, res) => {
  const machines = [];
  const seen     = new Set();

  // ── From saas_machines (has human name + plant context) ─────────
  try {
    const r = await dbCNC.query(`
      SELECT sm.machine_id,
             COALESCE(sm.machine_name, sm.machine_id) AS machine_name,
             COALESCE(sm.machine_type, 'CNC')         AS machine_type,
             COALESCE(sp.plant_name, 'Plant')         AS plant_name,
             COALESCE(sp.plant_code, '')              AS plant_code
      FROM saas_machines sm
      LEFT JOIN saas_plants sp ON sp.id = sm.plant_id
      WHERE sm.machine_id IS NOT NULL AND sm.machine_id <> ''
      ORDER BY sp.plant_name, sm.machine_name
    `);
    r.rows.forEach(row => {
      if (!seen.has(row.machine_id)) { seen.add(row.machine_id); machines.push(row); }
    });
  } catch(_) {}

  // ── From cnc_data (any machine_id that has actual telemetry) ────
  try {
    const r = await dbCNC.query(
      `SELECT DISTINCT machine_id FROM cnc_data WHERE machine_id IS NOT NULL ORDER BY machine_id`
    );
    r.rows.forEach(row => {
      if (!seen.has(row.machine_id)) {
        seen.add(row.machine_id);
        machines.push({ machine_id: row.machine_id, machine_name: row.machine_id,
                        machine_type: 'CNC', plant_name: '—', plant_code: '' });
      }
    });
  } catch(_) {}

  // ── Always ensure MACHINE001 is present ─────────────────────────────
  if (!seen.has('MACHINE001')) {
    machines.unshift({ machine_id:'MACHINE001', machine_name:'Demo Machine Hobbing M-896',
                       machine_type:'CNC', plant_name:'Demo Plant', plant_code:'DEL' });
  }

  res.json({ ok: true, data: machines });
});

// ══════════════════════════════════════════════════════════════════════
// DOWNTIME ANALYSIS — auto-detect events from cnc_data state transitions
// ══════════════════════════════════════════════════════════════════════
app.get('/downtime-analysis', pageAuth, (req,res) => res.sendFile(path.join(__dirname,'public','downtime-analysis.html')));

// GET /api/cnc/downtime-events?machine=MACHINE001&date=YYYY-MM-DD&shift=A
// Uses gap-and-island SQL to find non-RUNNING windows in cnc_data
app.get('/api/cnc/downtime-events', async (req, res) => {
  try {
    const machine   = req.query.machine || 'MACHINE001';
    const dateStr   = req.query.date   || new Date().toLocaleDateString('en-CA');
    const shiftReq  = (req.query.shift || 'A').toUpperCase();
    let shiftStart, shiftEnd;
    if (shiftReq === 'B') {
      shiftStart = `${dateStr}T19:00:00+05:30`;
      const next = new Date(`${dateStr}T19:00:00+05:30`);
      next.setDate(next.getDate() + 1);
      shiftEnd = next.toISOString().slice(0,10) + 'T07:00:00+05:30';
    } else {
      shiftStart = `${dateStr}T07:00:00+05:30`;
      shiftEnd   = `${dateStr}T19:00:00+05:30`;
    }

    // Gap-and-island: every time machine returns to a RUNNING-equivalent state,
    // run_grp increments. All non-running rows sharing same run_grp = one downtime event.
    // RUNNING-equivalent: 'RUNNING', 'AUTO', 'BUSY' (consistent with OEE calc).
    // Using MAX/BOOL_OR instead of MODE() for broader PG compatibility.
    const r = await dbCNC.query(`
      WITH ordered AS (
        SELECT time, machine_state, alarm_active, alarm_no,
          -- Group increments each time machine transitions back to a running state
          SUM(CASE WHEN UPPER(COALESCE(machine_state,'')) IN ('RUNNING','AUTO','BUSY') THEN 1 ELSE 0 END)
            OVER (ORDER BY time ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS run_grp
        FROM cnc_data
        WHERE machine_id = $1
          AND time >= $2::timestamptz
          AND time <  $3::timestamptz
      ),
      down_rows AS (
        -- All rows where machine is NOT in a running state
        SELECT * FROM ordered
        WHERE UPPER(COALESCE(machine_state,'')) NOT IN ('RUNNING','AUTO','BUSY')
          AND machine_state IS NOT NULL
          AND machine_state <> ''
      ),
      events AS (
        SELECT
          run_grp,
          MIN(time)                                AS start_utc,
          MAX(time) + INTERVAL '5 seconds'         AS end_utc,
          EXTRACT(EPOCH FROM (MAX(time) - MIN(time))) + 5 AS duration_sec,
          CASE
            WHEN BOOL_OR(UPPER(machine_state) = 'EMERGENCY') THEN 'EMERGENCY'
            WHEN BOOL_OR(UPPER(machine_state) IN ('ALARM','FAULT','ERROR')) THEN 'ALARM'
            WHEN BOOL_OR(alarm_active = true) THEN 'ALARM'
            ELSE 'IDLE'
          END                                      AS state,
          BOOL_OR(COALESCE(alarm_active, false))   AS had_alarm,
          MAX(CASE WHEN alarm_no IS NOT NULL AND alarm_no::text <> '' AND alarm_no::text <> '0' THEN alarm_no::text ELSE NULL END) AS alarm_no,
          COUNT(*)                                 AS readings
        FROM down_rows
        GROUP BY run_grp
        HAVING EXTRACT(EPOCH FROM (MAX(time) - MIN(time))) >= 0
      )
      SELECT
        run_grp                               AS event_id,
        start_utc AT TIME ZONE 'Asia/Kolkata' AS start_ist,
        end_utc   AT TIME ZONE 'Asia/Kolkata' AS end_ist,
        start_utc,
        end_utc,
        ROUND(duration_sec::numeric)          AS duration_sec,
        ROUND(duration_sec::numeric / 60, 1)  AS duration_min,
        state, had_alarm, alarm_no, readings,
        CASE
          WHEN duration_sec < 60  THEN 'MINOR'
          WHEN duration_sec < 600 THEN 'MEDIUM'
          ELSE                         'MAJOR'
        END AS severity
      FROM events
      ORDER BY start_utc
    `, [machine, shiftStart, shiftEnd]);

    // Diagnostic: count non-running rows to help debug zero-events case
    let diagCount = 0;
    try {
      const diag = await dbCNC.query(
        `SELECT COUNT(*) AS cnt FROM cnc_data
         WHERE machine_id=$1 AND time >= $2::timestamptz AND time < $3::timestamptz
           AND UPPER(COALESCE(machine_state,'')) NOT IN ('RUNNING','AUTO','BUSY')
           AND machine_state IS NOT NULL AND machine_state <> ''`,
        [machine, shiftStart, shiftEnd]
      );
      diagCount = parseInt(diag.rows[0]?.cnt || 0);
    } catch(e) {}

    const events = r.rows;

    // Also include manually-entered downtime from cnc_downtime_log for this shift
    const manualRows = await dbCNC.query(
      `SELECT id, start_time, end_time, duration_min,
              COALESCE(reason_code, reason_detail, 'Manual Entry') AS downtime_category,
              severity, reason_detail, operator_name, type,
              TRUE AS is_manual
       FROM cnc_downtime_log
       WHERE machine_id=$1 AND shift_date=$2 AND shift=$3
       ORDER BY start_time`,
      [machine, dateStr, shiftReq]
    ).catch(() => ({ rows: [] }));

    // Convert manual rows to same shape as auto-detected events
    manualRows.rows.forEach((m, i) => {
      const durSec = m.duration_min ? Math.round(m.duration_min * 60) : 0;
      events.push({
        event_id:     'M' + m.id,
        start_utc:    m.start_time,
        end_utc:      m.end_time,
        start_ist:    m.start_time,
        end_ist:      m.end_time,
        duration_sec: durSec,
        duration_min: m.duration_min,
        state:        m.type === 'PLANNED' ? 'PLANNED' : 'MANUAL',
        had_alarm:    false,
        alarm_no:     null,
        readings:     0,
        severity:     durSec < 60 ? 'MINOR' : durSec < 600 ? 'MEDIUM' : 'MAJOR',
        is_manual:    true,
        manual_id:    m.id,
        downtime_category: m.downtime_category,
        rca: { downtime_category: m.downtime_category, rca_status: 'CLOSED', reason_detail: m.reason_detail }
      });
    });

    // Sort by start time after merging
    events.sort((a, b) => new Date(a.start_utc) - new Date(b.start_utc));

    // Fetch saved RCA records — safe catch in case table doesn't exist yet
    let rca = { rows: [] };
    try {
      rca = await dbCNC.query(
        `SELECT * FROM cnc_downtime_rca WHERE machine_id=$1 AND shift_date=$2 AND shift=$3`,
        [machine, dateStr, shiftReq]
      );
    } catch(e) { /* table may not exist yet — needs pm2 restart */ }
    const rcaMap = {};
    rca.rows.forEach(row => {
      try { rcaMap[new Date(row.start_time).toISOString()] = row; } catch(e) {}
    });

    // Merge RCA data into events
    events.forEach(ev => {
      const key = new Date(ev.start_utc).toISOString();
      if (rcaMap[key]) {
        ev.rca = rcaMap[key];
        ev.rca_status = rcaMap[key].rca_status;
        ev.downtime_category = rcaMap[key].downtime_category;
      }
    });

    // Summary totals
    const summary = { minor: { count:0, total_sec:0 }, medium: { count:0, total_sec:0 }, major: { count:0, total_sec:0 } };
    events.forEach(ev => {
      const sev = (ev.severity || 'MINOR').toLowerCase();
      summary[sev].count++;
      summary[sev].total_sec += parseFloat(ev.duration_sec) || 0;
    });

    res.json({ ok: true, shift: shiftReq, date: dateStr, machine, events, summary, rca_records: rca.rows.length, diag_nonrunning_rows: diagCount });
  } catch(e) {
    console.error('[downtime-events]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/cnc/downtime-rca?machine=MACHINE001&date=YYYY-MM-DD&shift=A
app.get('/api/cnc/downtime-rca', async (req, res) => {
  try {
    const machine  = req.query.machine || 'MACHINE001';
    const dateStr  = req.query.date   || new Date().toLocaleDateString('en-CA');
    const shiftReq = (req.query.shift || 'A').toUpperCase();
    const r = await dbCNC.query(
      `SELECT * FROM cnc_downtime_rca WHERE machine_id=$1 AND shift_date=$2 AND shift=$3 ORDER BY start_time`,
      [machine, dateStr, shiftReq]
    );
    res.json({ ok: true, data: r.rows });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/cnc/downtime-rca — upsert RCA for a downtime event
app.post('/api/cnc/downtime-rca', async (req, res) => {
  try {
    const {
      machine_id, shift_date, shift, start_time, end_time, duration_sec, duration_min,
      severity, state, alarm_no,
      downtime_category, why1, why2, why3, why4, why5,
      immediate_action, corrective_action, preventive_action,
      responsible_person, target_date, closure_date, rca_status, rca_notes, updated_by
    } = req.body;

    await dbCNC.query(`
      INSERT INTO cnc_downtime_rca
        (machine_id,shift_date,shift,start_time,end_time,duration_sec,duration_min,
         severity,state,alarm_no,
         downtime_category,why1,why2,why3,why4,why5,
         immediate_action,corrective_action,preventive_action,
         responsible_person,target_date,closure_date,rca_status,rca_notes,updated_by,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,NOW())
      ON CONFLICT (machine_id, start_time) DO UPDATE SET
        end_time=$5, duration_sec=$6, duration_min=$7, severity=$8, state=$9, alarm_no=$10,
        downtime_category=$11, why1=$12, why2=$13, why3=$14, why4=$15, why5=$16,
        immediate_action=$17, corrective_action=$18, preventive_action=$19,
        responsible_person=$20, target_date=$21, closure_date=$22,
        rca_status=$23, rca_notes=$24, updated_by=$25, updated_at=NOW()
    `, [
      machine_id||'MACHINE001', shift_date, shift, start_time, end_time||null,
      duration_sec||null, duration_min||null, severity||null, state||null, alarm_no||null,
      downtime_category||null, why1||null, why2||null, why3||null, why4||null, why5||null,
      immediate_action||null, corrective_action||null, preventive_action||null,
      responsible_person||null, target_date||null, closure_date||null,
      rca_status||'OPEN', rca_notes||null, updated_by||null
    ]);
    res.json({ ok: true });
  } catch(e) {
    console.error('[downtime-rca POST]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/cnc/downtime-summary?machine=MACHINE001&days=30
// Day-by-shift summary of Minor/Medium/Major counts and totals
app.get('/api/cnc/downtime-summary', async (req, res) => {
  try {
    const machine = req.query.machine || 'MACHINE001';
    const days    = parseInt(req.query.days) || 30;
    const r = await dbCNC.query(`
      SELECT
        shift_date::text AS date,
        shift,
        severity,
        COUNT(*)                                        AS event_count,
        ROUND(SUM(duration_min)::numeric, 1)            AS total_min,
        COUNT(*) FILTER (WHERE rca_status = 'CLOSED')   AS closed_count,
        COUNT(*) FILTER (WHERE rca_status = 'OPEN')     AS open_count
      FROM cnc_downtime_rca
      WHERE machine_id=$1 AND shift_date >= CURRENT_DATE - ($2 || ' days')::interval
      GROUP BY shift_date, shift, severity
      ORDER BY shift_date DESC, shift, severity
    `, [machine, days]);
    res.json({ ok: true, data: r.rows });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/cnc/rejection-log', async (req,res) => {
  try {
    const { date, shift, machine, limit } = req.query;
    const mid  = machine || 'MACHINE001';
    const from = date || new Date().toISOString().slice(0,10);
    const lim  = parseInt(limit) || 500;

    // ── Rejection log entries ─────────────────────────────────────
    const r = await dbCNC.query(
      `SELECT * FROM cnc_rejection_log
       WHERE machine_id = $3
         AND shift_date >= ($1::date - INTERVAL '30 days')
         ${date  ? 'AND shift_date = $1::date' : ''}
         ${shift && shift !== 'Both' ? `AND shift = '${shift.replace(/'/g,"''")}'` : ''}
       ORDER BY shift_date DESC, log_hour DESC LIMIT $2`,
      [from, lim, mid]
    );

    // ── Shift production context (from oee_results + live cnc_data) ──
    // Returns per-shift parts_produced so the UI can compute real quality %
    const ctxR = await dbCNC.query(`
      SELECT shift,
             COALESCE(parts_produced, 0)   AS parts_produced,
             COALESCE(rejection_count, 0)  AS rejection_count,
             COALESCE(good_parts, 0)       AS good_parts,
             COALESCE(quality, 100)        AS quality,
             COALESCE(oee, 0)              AS oee
      FROM oee_results
      WHERE machine_id = $1 AND shift_date = $2
      ORDER BY shift`, [mid, from]);

    // ── Live parts count for current shift (MAX - MIN part_count) ──
    const IST_OFF  = 5.5 * 3600 * 1000;
    const istNow   = new Date(Date.now() + IST_OFF);
    const todayIST = istNow.toISOString().slice(0, 10);
    let live_parts_a = 0, live_parts_b = 0;
    if (from === todayIST) {
      try {
        // Use proven timestamptz format: date + shift offset +05:30
        const liveA = await dbCNC.query(
          `SELECT GREATEST(0, MAX(part_count::INT) - MIN(part_count::INT)) AS parts
           FROM cnc_data WHERE machine_id=$1
             AND time >= ($2::text || 'T07:00:00+05:30')::TIMESTAMPTZ
             AND time <  ($2::text || 'T19:00:00+05:30')::TIMESTAMPTZ`,
          [mid, from]);
        live_parts_a = parseInt(liveA.rows[0]?.parts || 0);
        const liveB = await dbCNC.query(
          `SELECT GREATEST(0, MAX(part_count::INT) - MIN(part_count::INT)) AS parts
           FROM cnc_data WHERE machine_id=$1
             AND time >= ($2::text || 'T19:00:00+05:30')::TIMESTAMPTZ`,
          [mid, from]);
        live_parts_b = parseInt(liveB.rows[0]?.parts || 0);
      } catch(_) {}
    }

    res.json({
      ok: true,
      data: r.rows,
      shift_context: ctxR.rows,
      live_parts: { A: live_parts_a, B: live_parts_b }
    });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/api/cnc/rejection-log', async (req,res) => {
  try {
    const {shift_date,shift,log_hour,program_no,good_parts,rejected_parts,rejection_reason,
           operator_name,defect_type,action_to_take,assigned_to,assigned_email,machine_id} = req.body;
    const mid      = machine_id || 'MACHINE001';
    const rejected = parseInt(rejected_parts) || 0;
    const sev = rejected <= 1 ? 'MINOR' : rejected <= 5 ? 'SECOND_LEVEL' : 'MAJOR';
    await dbCNC.query(
      `INSERT INTO cnc_rejection_log(machine_id,shift_date,shift,log_hour,program_no,good_parts,rejected_parts,
         rejection_reason,operator_name,defect_type,severity,action_to_take,assigned_to,assigned_email)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [mid,shift_date,shift,log_hour||new Date().getHours(),program_no||null,good_parts||0,rejected,
       rejection_reason||null,operator_name||null,defect_type||null,sev,
       action_to_take||null,assigned_to||null,assigned_email||null]
    );

    // ── Immediately recalculate OEE so quality updates everywhere ──
    setImmediate(async () => {
      try { await dbCNC.query(`SELECT populate_oee_today()`); } catch(_) {}
    });

    // ── Email for MAJOR quality rejection ─────────────────────────
    if (sev === 'MAJOR' && assigned_email) {
      try {
        const store = loadAlertStore();
        if (store.smtp && store.smtp.host) {
          const { sendAlertEmail } = require('./lib/mailer');
          await sendAlertEmail({
            smtp: store.smtp,
            to: assigned_email,
            subject: `🚨 MAJOR QUALITY EVENT — ${rejected} pcs rejected | ${defect_type || 'Unspecified'}`,
            rule: { name:'Major Quality Event', condition:'gt', threshold:5, severity:'critical' },
            value: `${rejected} rejected parts on ${shift_date} Shift ${shift}`,
            liveData: { machine_id: mid, operator_name, defect_type, rejection_reason,
                        action_to_take, assigned_to, shift_date, shift }
          });
        }
      } catch(mailErr) { console.warn('[Quality] Email failed:', mailErr.message); }
    }
    res.json({ ok:true, severity: sev });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.delete('/api/cnc/rejection-log/:id', async (req,res) => {
  try {
    await dbCNC.query('DELETE FROM cnc_rejection_log WHERE id=$1',[req.params.id]);
    // Recalculate OEE after deletion
    setImmediate(async () => {
      try { await dbCNC.query(`SELECT populate_oee_today()`); } catch(_) {}
    });
    res.json({ok:true});
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ── CNC history by absolute date range (used by parameter-report) ──
// GET /api/cnc/history?from=ISO&to=ISO&machine=MACHINE001&interval=1min
app.get('/api/cnc/history', async (req,res) => {
  cors(res);
  try {
    const machine  = req.query.machine  || 'MACHINE001';
    const from     = req.query.from     || new Date(Date.now()-86400000).toISOString();
    const to       = req.query.to       || new Date().toISOString();
    const interval = req.query.interval || '1 minute';
    const r = await dbCNC.query(
      `SELECT time_bucket($3::interval, time) AS bucket,
              ROUND(AVG(spindle_speed)::numeric,1)       AS spindle_speed,
              ROUND(AVG(feed_rate)::numeric,1)           AS feed_rate,
              ROUND(AVG(raw_cycle_time_sec)::numeric,2)  AS raw_cycle_time_sec,
              MAX(part_count)                            AS part_count,
              ROUND(MAX(last_cycle_time_sec)::numeric,2) AS last_cycle_time_sec,
              MODE() WITHIN GROUP (ORDER BY machine_state) AS machine_state,
              SUM(CASE WHEN is_running THEN 1 ELSE 0 END) AS running_rows,
              COUNT(*) AS total_rows
       FROM cnc_data
       WHERE machine_id=$1 AND time >= $3 AND time <= $4
       GROUP BY bucket ORDER BY bucket ASC`,
      [machine, interval, from, to]
    );
    res.json({ ok:true, data:r.rows, count:r.rows.length });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ── Shift Input API ───────────────────────────────────────────────
app.get('/api/cnc/shift-log', async (req,res) => {
  try {
    const {date} = req.query;
    const from = date || new Date().toISOString().slice(0,10);
    const r = await dbCNC.query(
      `SELECT s.*, p.part_name FROM cnc_shift_log s
       LEFT JOIN program_master p ON p.program_no=s.program_no
       WHERE shift_date=$1 ORDER BY shift`,
      [from]
    );
    res.json({ok:true,data:r.rows});
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/cnc/shift-log', async (req,res) => {
  try {
    const {shift_date,shift,operator_name,supervisor,program_no,target_parts,notes} = req.body;
    await dbCNC.query(
      `INSERT INTO cnc_shift_log(shift_date,shift,operator_name,supervisor,program_no,target_parts,notes)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(machine_id,shift_date,shift) DO UPDATE SET
       operator_name=$3,supervisor=$4,program_no=$5,target_parts=$6,notes=$7`,
      [shift_date,shift,operator_name||null,supervisor||null,program_no||null,target_parts||920,notes||null]
    );
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ══════════════════════════════════════════════════════════════════════
// ISA-95 / IEC 62264 CONFIG GENERATOR
// ══════════════════════════════════════════════════════════════════════
function generateISA95Config(machine, plant, tenant) {
  const machineType = (machine.type || 'CNC').toUpperCase();
  const protocol    = (machine.protocol || '').toUpperCase();
  const machineMake = machine.make  || '';
  const machineModel= machine.model || '';

  // Data point definitions keyed by machine type
  const DATA_POINTS = {
    CNC: [
      { tag:'machine_state',       label:'Machine State',         type:'VARCHAR(20)', unit:'',    isa95_category:'Equipment Status',  mqtt_type:'string',  nodered_path:'payload.machine_state',    description:'Operational state: RUNNING / IDLE / ALARM / STOPPED / EMERGENCY' },
      { tag:'is_running',          label:'Is Running',            type:'BOOLEAN',     unit:'',    isa95_category:'Equipment Status',  mqtt_type:'boolean', nodered_path:'payload.is_running',       description:'True when machine is actively cutting' },
      { tag:'auto_mode',           label:'Auto Mode',             type:'BOOLEAN',     unit:'',    isa95_category:'Equipment Status',  mqtt_type:'boolean', nodered_path:'payload.auto_mode',        description:'True when CNC is in AUTO / MEM mode' },
      { tag:'emergency',           label:'Emergency Stop',        type:'BOOLEAN',     unit:'',    isa95_category:'Safety',            mqtt_type:'boolean', nodered_path:'payload.emergency',        description:'E-stop active' },
      { tag:'alarm_active',        label:'Alarm Active',          type:'BOOLEAN',     unit:'',    isa95_category:'Equipment Status',  mqtt_type:'boolean', nodered_path:'payload.alarm_active',     description:'Any alarm present on controller' },
      { tag:'alarm_no',            label:'Alarm Number',          type:'INTEGER',     unit:'',    isa95_category:'Alarm',             mqtt_type:'integer', nodered_path:'payload.alarm_no',         description:'Industrial CNC alarm code number' },
      { tag:'program_no',          label:'Active Program No.',    type:'INTEGER',     unit:'',    isa95_category:'Process Control',   mqtt_type:'integer', nodered_path:'payload.program_no',       description:'CNC O-number of active machining program' },
      { tag:'part_count',          label:'Part Count (shift)',    type:'INTEGER',     unit:'pcs', isa95_category:'Production',        mqtt_type:'integer', nodered_path:'payload.part_count',       description:'Cumulative part count from shift start' },
      { tag:'last_cycle_time_sec', label:'Last Cycle Time',       type:'NUMERIC(10,2)',unit:'sec',isa95_category:'Production',        mqtt_type:'float',   nodered_path:'payload.last_cycle_time_sec', description:'Cycle time of the most recently completed part' },
      { tag:'raw_cycle_time_sec',  label:'Raw Cycle Time',        type:'NUMERIC(10,2)',unit:'sec',isa95_category:'Production',        mqtt_type:'float',   nodered_path:'payload.raw_cycle_time_sec',  description:'Elapsed time since last part-complete signal' },
      { tag:'idle_time_sec',       label:'Idle Time',             type:'NUMERIC(10,2)',unit:'sec',isa95_category:'OEE - Availability',mqtt_type:'float',   nodered_path:'payload.idle_time_sec',    description:'Accumulated idle seconds in current state window' },
      { tag:'spindle_speed',       label:'Spindle Speed',         type:'NUMERIC(10,2)',unit:'rpm',isa95_category:'Process Parameter', mqtt_type:'float',   nodered_path:'payload.spindle_speed',    description:'Actual spindle speed (rpm)' },
      { tag:'feed_rate',           label:'Feed Rate',             type:'NUMERIC(10,2)',unit:'mm/min',isa95_category:'Process Parameter',mqtt_type:'float', nodered_path:'payload.feed_rate',        description:'Actual axis feed rate (mm/min)' },
      { tag:'run_status',          label:'Run Status',            type:'VARCHAR(20)', unit:'',    isa95_category:'Equipment Status',  mqtt_type:'string',  nodered_path:'payload.run_status',       description:'Detailed run status from Industrial CNC FOCAS' },
    ],
    PLC: [
      { tag:'machine_state',  label:'Machine State',   type:'VARCHAR(20)',   unit:'',    isa95_category:'Equipment Status', mqtt_type:'string',  nodered_path:'payload.machine_state',  description:'PLC operational state' },
      { tag:'cycle_active',   label:'Cycle Active',    type:'BOOLEAN',       unit:'',    isa95_category:'Equipment Status', mqtt_type:'boolean', nodered_path:'payload.cycle_active',   description:'Auto cycle in progress' },
      { tag:'fault_code',     label:'Fault Code',      type:'INTEGER',       unit:'',    isa95_category:'Alarm',            mqtt_type:'integer', nodered_path:'payload.fault_code',     description:'PLC fault register value' },
      { tag:'part_count',     label:'Part Count',      type:'INTEGER',       unit:'pcs', isa95_category:'Production',       mqtt_type:'integer', nodered_path:'payload.part_count',     description:'Parts produced' },
      { tag:'cycle_time_sec', label:'Cycle Time',      type:'NUMERIC(10,2)', unit:'sec', isa95_category:'Production',       mqtt_type:'float',   nodered_path:'payload.cycle_time_sec', description:'Last cycle time in seconds' },
      { tag:'temperature',    label:'Temperature',     type:'NUMERIC(8,2)',  unit:'°C',  isa95_category:'Process Parameter',mqtt_type:'float',   nodered_path:'payload.temperature',    description:'Process or ambient temperature' },
      { tag:'pressure',       label:'Pressure',        type:'NUMERIC(8,2)',  unit:'bar', isa95_category:'Process Parameter',mqtt_type:'float',   nodered_path:'payload.pressure',       description:'Hydraulic / pneumatic pressure' },
      { tag:'energy_kwh',     label:'Energy (kWh)',     type:'NUMERIC(12,4)', unit:'kWh', isa95_category:'Utility',          mqtt_type:'float',   nodered_path:'payload.energy_kwh',     description:'Energy consumption counter' },
    ],
    SENSOR: [
      { tag:'reading',        label:'Sensor Reading',  type:'NUMERIC(14,4)', unit:'',    isa95_category:'Process Parameter',mqtt_type:'float',   nodered_path:'payload.reading',        description:'Primary sensor value' },
      { tag:'status',         label:'Status',          type:'VARCHAR(20)',   unit:'',    isa95_category:'Equipment Status', mqtt_type:'string',  nodered_path:'payload.status',         description:'Sensor health status' },
      { tag:'temperature',    label:'Temperature',     type:'NUMERIC(8,2)',  unit:'°C',  isa95_category:'Environment',      mqtt_type:'float',   nodered_path:'payload.temperature',    description:'Ambient temperature at sensor' },
      { tag:'vibration_rms',  label:'Vibration (RMS)', type:'NUMERIC(8,4)',  unit:'mm/s',isa95_category:'Predictive',       mqtt_type:'float',   nodered_path:'payload.vibration_rms',  description:'RMS vibration level for predictive alerts' },
      { tag:'alert_flag',     label:'Alert Flag',      type:'BOOLEAN',       unit:'',    isa95_category:'Alarm',            mqtt_type:'boolean', nodered_path:'payload.alert_flag',     description:'True when reading exceeds threshold' },
    ],
    MANUAL: [
      { tag:'part_count',       label:'Parts Produced',  type:'INTEGER',      unit:'pcs', isa95_category:'Production',       mqtt_type:'integer', nodered_path:'payload.part_count',       description:'Manually entered part count' },
      { tag:'rejected_parts',   label:'Rejected Parts',  type:'INTEGER',      unit:'pcs', isa95_category:'Quality',          mqtt_type:'integer', nodered_path:'payload.rejected_parts',   description:'Manually entered rejects' },
      { tag:'downtime_minutes', label:'Downtime (min)',  type:'NUMERIC(8,1)', unit:'min', isa95_category:'OEE - Availability',mqtt_type:'float',  nodered_path:'payload.downtime_minutes', description:'Manually logged downtime in minutes' },
      { tag:'downtime_reason',  label:'Downtime Reason', type:'VARCHAR(128)', unit:'',    isa95_category:'OEE - Availability',mqtt_type:'string', nodered_path:'payload.downtime_reason',  description:'Free-text downtime cause' },
      { tag:'operator',         label:'Operator Name',   type:'VARCHAR(64)',  unit:'',    isa95_category:'Personnel',        mqtt_type:'string',  nodered_path:'payload.operator',         description:'Name of operator entering data' },
    ],
  };

  const dataPoints = DATA_POINTS[machineType] || DATA_POINTS.MANUAL;

  // Determine MQTT base topic
  const tenantSlug  = (tenant.slug || 'tenant').replace(/[^a-z0-9-]/g,'');
  const plantCode   = (plant.code  || 'plant').replace(/[^a-zA-Z0-9_]/g,'_').toLowerCase();
  const machineSlug = (machine.machine_id || 'machine').replace(/[^a-zA-Z0-9_]/g,'_').toLowerCase();
  const mqttBase    = `factory-mios/${tenantSlug}/${plantCode}/${machineSlug}`;

  const isa95 = {
    _meta: {
      standard:   'ISA-95 / IEC 62264',
      generated:  new Date().toISOString(),
      version:    '1.0',
    },
    enterprise: {
      id:    tenantSlug,
      name:  tenant.name || tenantSlug,
    },
    site: {
      id:   plantCode,
      name: plant.name || plantCode,
    },
    area: {
      id:   `${plantCode}_MACHINING`,
      name: 'Machining Area',
    },
    work_center: {
      id:   `${plantCode}_WC_${machineSlug.toUpperCase()}`,
      name: machine.name || machine.machine_id,
    },
    work_unit: {
      id:          machine.machine_id,
      name:        machine.name,
      type:        machineType,
      make:        machineMake,
      model:       machineModel,
      protocol:    machine.protocol || 'MQTT',
      data_source: machine.data_source || 'mqtt',
      host:        machine.host || '',
      port:        machine.port || null,
    },
    mqtt: {
      broker_host:       machine.host || '<MQTT_BROKER_IP>',
      broker_port:       machine.port || 1883,
      topic_telemetry:   `${mqttBase}/telemetry`,
      topic_state:       `${mqttBase}/state`,
      topic_alarm:       `${mqttBase}/alarm`,
      topic_heartbeat:   `${mqttBase}/heartbeat`,
      qos:               1,
      retain:            false,
      publish_interval_sec: 5,
      payload_format:    'JSON',
      example_payload: (() => {
        const ex = { timestamp: new Date().toISOString(), machine_id: machine.machine_id };
        dataPoints.forEach(dp => {
          if (dp.mqtt_type === 'boolean') ex[dp.tag] = false;
          else if (dp.mqtt_type === 'integer') ex[dp.tag] = 0;
          else if (dp.mqtt_type === 'float')   ex[dp.tag] = 0.0;
          else ex[dp.tag] = '';
        });
        return ex;
      })(),
    },
    data_points: dataPoints.map(dp => ({
      tag:           dp.tag,
      label:         dp.label,
      sql_type:      dp.type,
      unit:          dp.unit,
      mqtt_type:     dp.mqtt_type,
      isa95_category:dp.isa95_category,
      nodered_path:  dp.nodered_path,
      description:   dp.description,
      required:      ['machine_state','part_count'].includes(dp.tag),
    })),
    node_red: {
      mqtt_in_topic:  `${mqttBase}/telemetry`,
      insert_table:   `cnc_data`,
      sample_function:`
// Node-RED function node: parse MQTT payload → INSERT to TimescaleDB
var p = msg.payload;
msg.topic = "INSERT INTO cnc_data (time, machine_id, machine_state, is_running, part_count, last_cycle_time_sec, spindle_speed, feed_rate, alarm_active, alarm_no, program_no) VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)";
msg.params = [
  "${machine.machine_id}",
  p.machine_state || "IDLE",
  p.is_running || false,
  p.part_count || 0,
  p.last_cycle_time_sec || 0,
  p.spindle_speed || 0,
  p.feed_rate || 0,
  p.alarm_active || false,
  p.alarm_no || null,
  p.program_no || 0
];
return msg;`,
    },
  };

  return isa95;
}

// ══════════════════════════════════════════════════════════════════════
// SAAS PLATFORM MANAGEMENT API
// ══════════════════════════════════════════════════════════════════════
app.get('/my-dashboards', pageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'my-dashboards.html')));

app.get('/saas-platform', pageAuth, (req, res) => {
  // Decode the JWT to get the role — pageAuth already verified the token
  const token = req.cookies?.oee_token || (ALLOW_QUERY_TOKEN_AUTH ? req.query._token : null) || req.headers.authorization?.replace('Bearer ', '');
  let role = '';
  try { role = verifyToken(token)?.role || ''; } catch {}
  if (role !== 'superadmin' && role !== 'admin') {
    // Redirect non-admin users with a friendly message via query param
    return res.redirect('/login?redirect=' + encodeURIComponent('/saas-platform') + '&hint=platform');
  }
  res.sendFile(path.join(__dirname,'public','saas-platform.html'));
});

// Overview stats
app.get('/api/saas/overview', authMiddleware, async (req,res) => {
  try {
    const [t,p,m,u,dp] = await Promise.all([
      db.query('SELECT COUNT(*) AS n FROM tenants').catch(()=>({rows:[{n:0}]})),
      db.query('SELECT COUNT(*) AS n FROM saas_plants').catch(()=>({rows:[{n:0}]})),
      db.query('SELECT COUNT(*) AS n FROM saas_machines').catch(()=>({rows:[{n:0}]})),
      db.query("SELECT COUNT(*) AS n FROM users WHERE status IS DISTINCT FROM 'inactive'").catch(()=>({rows:[{n:0}]})),
      dbCNC.query("SELECT COUNT(*) AS n FROM cnc_data WHERE time >= NOW() - INTERVAL '24 hours'").catch(()=>({rows:[{n:0}]})),
    ]);
    res.json({ ok:true, tenants:t.rows[0].n, plants:p.rows[0].n, machines:m.rows[0].n,
               users:u.rows[0].n, data_points_today:dp.rows[0].n });
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// Tenants CRUD
app.get('/api/saas/tenants', authMiddleware, async(req,res) => {
  try {
    const r = await db.query(`SELECT t.*, (SELECT COUNT(*) FROM saas_plants WHERE tenant_id=t.id) AS plant_count FROM tenants t ORDER BY t.created_at DESC`);
    res.json({ok:true, data:r.rows});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});
app.post('/api/saas/tenants', authMiddleware, async(req,res) => {
  try {
    const {name,slug,industry,contact_email,plan,max_plants,max_users} = req.body;
    if(!name||!slug) return res.status(400).json({ok:false,error:'name and slug required'});
    const r = await db.query(
      `INSERT INTO tenants(name,slug,industry,contact_email,plan,max_plants,max_users) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name,slug,industry||null,contact_email||null,plan||'basic',max_plants||5,max_users||10]
    );
    await db.query(`INSERT INTO saas_audit_log(action,entity,entity_id,details) VALUES('CREATE','tenant',$1,$2)`,
      [r.rows[0].id, `Created tenant: ${name}`]).catch(()=>{});
    res.json({ok:true,data:r.rows[0]});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});
app.put('/api/saas/tenants/:id', authMiddleware, async(req,res) => {
  try {
    const {name,industry,contact_email,plan,status,max_plants,max_users} = req.body;
    const r = await db.query(
      `UPDATE tenants SET name=COALESCE($1,name),industry=COALESCE($2,industry),contact_email=COALESCE($3,contact_email),
       plan=COALESCE($4,plan),status=COALESCE($5,status),max_plants=COALESCE($6,max_plants),
       max_users=COALESCE($7,max_users),updated_at=NOW() WHERE id=$8 RETURNING *`,
      [name,industry,contact_email,plan,status,max_plants,max_users,req.params.id]
    );
    res.json({ok:true,data:r.rows[0]});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});
app.delete('/api/saas/tenants/:id', authMiddleware, async(req,res) => {
  try {
    await db.query('DELETE FROM tenants WHERE id=$1',[req.params.id]);
    res.json({ok:true});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// Plants CRUD
app.get('/api/saas/plants', authMiddleware, async(req,res) => {
  try {
    const where = req.query.tenant_id ? 'WHERE p.tenant_id=$1' : '';
    const params = req.query.tenant_id ? [req.query.tenant_id] : [];
    const r = await db.query(
      `SELECT p.*, t.name AS tenant_name,
       (SELECT COUNT(*) FROM saas_machines WHERE plant_id=p.id) AS machine_count
       FROM saas_plants p LEFT JOIN tenants t ON t.id=p.tenant_id ${where} ORDER BY p.created_at DESC`, params
    );
    res.json({ok:true,data:r.rows});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});
app.post('/api/saas/plants', authMiddleware, async(req,res) => {
  try {
    const {tenant_id,name,code,location,timezone,auto_dashboard} = req.body;
    if(!name||!code) return res.status(400).json({ok:false,error:'name and code required'});
    const r = await db.query(
      `INSERT INTO saas_plants(tenant_id,name,code,location,timezone,auto_dashboard) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenant_id||null,name,code,location||null,timezone||'Asia/Kolkata',auto_dashboard!==false]
    );
    const plant = r.rows[0];

    // Auto-provision DB schema for the new plant
    let provisionResult = null;
    try {
      const tenantRow = tenant_id
        ? (await db.query('SELECT * FROM tenants WHERE id=$1',[tenant_id])).rows[0]
        : { tenant_id: 'default', name: name };
      provisionResult = await provisionPlant(db, {
        tenant: { tenant_id: tenantRow?.slug || 'default', name: tenantRow?.name || name },
        plant:  { plant_id: code.toLowerCase(), plant_name: name },
        devices: [],
        shifts: [
          { name:'A', start:'07:00', end:'19:00', breaks:[{name:'Lunch',start:'13:00',end:'13:30'}] },
          { name:'B', start:'19:00', end:'07:00', breaks:[{name:'Dinner',start:'01:00',end:'01:30'}] },
        ],
      });
      console.log('[SaaS] Plant schema provisioned:', provisionResult.schema_name);
    } catch(pe) {
      console.warn('[SaaS] Plant provision warn:', pe.message);
    }

    await db.query(`INSERT INTO saas_audit_log(action,entity,entity_id,details) VALUES('CREATE','plant',$1,$2)`,
      [plant.id, `Created plant: ${name} for tenant ${tenant_id}`]).catch(()=>{});

    res.json({ ok:true, data:plant, provision: provisionResult });
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});
app.put('/api/saas/plants/:id', authMiddleware, async(req,res) => {
  try {
    const {name,code,location,timezone,status,auto_dashboard} = req.body;
    const r = await db.query(
      `UPDATE saas_plants SET name=COALESCE($1,name),code=COALESCE($2,code),location=COALESCE($3,location),
       timezone=COALESCE($4,timezone),status=COALESCE($5,status),auto_dashboard=COALESCE($6,auto_dashboard) WHERE id=$7 RETURNING *`,
      [name,code,location,timezone,status,auto_dashboard,req.params.id]
    );
    res.json({ok:true,data:r.rows[0]});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});
app.delete('/api/saas/plants/:id', authMiddleware, async(req,res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const pid = req.params.id;

    // Fetch plant info + machine count before deletion (for audit log + response)
    const plantRow = await client.query('SELECT * FROM saas_plants WHERE id=$1', [pid]);
    if (!plantRow.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Plant not found' });
    }
    const plant = plantRow.rows[0];
    const { rows: mc } = await client.query('SELECT COUNT(*) AS cnt FROM saas_machines WHERE plant_id=$1', [pid]);
    const machineCount = parseInt(mc[0].cnt);

    // Explicitly delete machines first (FK CASCADE also handles this, belt-and-braces)
    await client.query('DELETE FROM saas_machines WHERE plant_id=$1', [pid]);
    // Delete the plant itself
    await client.query('DELETE FROM saas_plants WHERE id=$1', [pid]);

    // Audit log
    await client.query(
      `INSERT INTO saas_audit_log(action,entity,entity_id,user_id,details)
       VALUES('DELETE','plant',$1,$2,$3)`,
      [pid, req.user?.username || 'unknown',
       `Deleted plant "${plant.name}" (code:${plant.code}) + ${machineCount} machine(s)`]
    ).catch(()=>{});

    await client.query('COMMIT');

    // Also remove from device_registry.json if present (soft registry)
    try {
      const registry = loadRegistry();
      const before = registry.plants.length;
      registry.plants = registry.plants.filter(p =>
        p.plant_id !== plant.code.toLowerCase() &&
        p.plant_id !== plant.code
      );
      if (registry.plants.length !== before) saveRegistry(registry);
    } catch(re) { /* registry update is best-effort */ }

    console.log(`[SaaS] 🗑️  Plant "${plant.name}" (id=${pid}) deleted + ${machineCount} machine(s) removed`);
    res.json({ ok: true, deleted: { plant: plant.name, code: plant.code, machines_removed: machineCount } });
  } catch(e) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('[SaaS] Plant delete error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

// Machines CRUD
app.get('/api/saas/machines', authMiddleware, async(req,res) => {
  try {
    const where = req.query.plant_id ? 'WHERE m.plant_id=$1' : '';
    const params = req.query.plant_id ? [req.query.plant_id] : [];
    const r = await db.query(
      `SELECT m.*, p.name AS plant_name, t.name AS tenant_name
       FROM saas_machines m
       LEFT JOIN saas_plants p ON p.id=m.plant_id
       LEFT JOIN tenants t ON t.id=p.tenant_id
       ${where} ORDER BY m.created_at DESC`, params
    );
    res.json({ok:true,data:r.rows});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});
app.post('/api/saas/machines', authMiddleware, async(req,res) => {
  try {
    const {plant_id,machine_id,name,type,make,model,protocol,host,port,data_source,description} = req.body;
    if(!machine_id||!name||!type) return res.status(400).json({ok:false,error:'machine_id, name, type required'});

    // Fetch plant + tenant context for ISA-95 generation
    let plant  = { id: plant_id, name:'Unknown Plant', code:'PLANT', location:'' };
    let tenant = { id: null, name:'Unknown Tenant', slug:'tenant' };
    if (plant_id) {
      try {
        const pr = await db.query(
          `SELECT p.*, t.name AS tenant_name, t.slug AS tenant_slug
           FROM saas_plants p LEFT JOIN tenants t ON t.id=p.tenant_id WHERE p.id=$1`, [plant_id]);
        if (pr.rows[0]) {
          plant  = pr.rows[0];
          tenant = { id: pr.rows[0].tenant_id, name: pr.rows[0].tenant_name, slug: pr.rows[0].tenant_slug };
        }
      } catch(e) {}
    }

    // Generate ISA-95 config
    const machineObj = { machine_id, name, type, make:make||'', model:model||'', protocol:protocol||'', host:host||'', port:port||null, data_source:data_source||'manual' };
    const isa95 = generateISA95Config(machineObj, plant, tenant);

    const r = await db.query(
      `INSERT INTO saas_machines(plant_id,machine_id,name,type,make,model,protocol,host,port,data_source,description,isa95_config)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [plant_id||null,machine_id,name,type,make||null,model||null,protocol||null,host||null,port||null,data_source||'manual',description||null,JSON.stringify(isa95)]
    );

    await db.query(`INSERT INTO saas_audit_log(action,entity,entity_id,details) VALUES('CREATE','machine',$1,$2)`,
      [r.rows[0].id, `Created machine: ${name} (${machine_id})`]).catch(()=>{});

    res.json({ ok:true, data:r.rows[0], isa95_config: isa95 });
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});
app.put('/api/saas/machines/:id', authMiddleware, async(req,res) => {
  try {
    const {name,type,protocol,host,port,data_source,description,status} = req.body;
    const r = await db.query(
      `UPDATE saas_machines SET name=COALESCE($1,name),type=COALESCE($2,type),protocol=COALESCE($3,protocol),
       host=COALESCE($4,host),port=COALESCE($5,port),data_source=COALESCE($6,data_source),
       description=COALESCE($7,description),status=COALESCE($8,status) WHERE id=$9 RETURNING *`,
      [name,type,protocol,host,port,data_source,description,status,req.params.id]
    );
    res.json({ok:true,data:r.rows[0]});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});
app.delete('/api/saas/machines/:id', authMiddleware, async(req,res) => {
  try {
    await db.query('DELETE FROM saas_machines WHERE id=$1',[req.params.id]);
    res.json({ok:true});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// ── Users CRUD (file-based — config/users.json) ────────────────────
// GET /api/saas/users — list all users (no password_hash)
app.get('/api/saas/users', authMiddleware, (req,res) => {
  try {
    const { loadUsers } = require('./lib/auth');
    const store = loadUsers();
    const users = (store.users || []).map(u => ({
      id:           u.id,
      username:     u.username,
      name:         u.name,
      email:        u.email || '',
      phone:        u.phone || '',
      role:         u.role,
      tenant_id:    u.tenant_id   || null,
      tenant_slug:  u.tenant_slug || null,
      plant_ids:    u.plant_ids   || [],
      active:       u.active !== false,
      created_at:   u.created_at,
    }));
    // Filter by role / tenant if requested
    const { role, tenant_id } = req.query;
    const filtered = users.filter(u =>
      (!role      || u.role === role) &&
      (!tenant_id || String(u.tenant_id) === String(tenant_id))
    );
    res.json({ ok:true, data: filtered });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/saas/users — create new user
app.post('/api/saas/users', authMiddleware, async(req,res) => {
  try {
    const { username, password, name, role, email, phone, tenant_id, tenant_slug, plant_ids } = req.body;
    if (!username || !password) return res.status(400).json({ ok:false, error:'username and password required' });
    const { createUser } = require('./lib/auth');
    const user = await createUser({ username, password, name, role, email, phone, plant_ids, tenant_id, tenant_slug });
    await db.query(`INSERT INTO saas_audit_log(action,entity,entity_id,details) VALUES('CREATE','user',$1,$2)`,
      [user.id, `Created user: ${username} / role: ${role}`]).catch(()=>{});
    const { password_hash: _, ...safe } = user;
    res.json({ ok:true, data: safe });
  } catch(e) { res.status(500).json({ ok:false, error: e.message }); }
});

// PUT /api/saas/users/:username — update user (name, role, email, phone, tenant, active)
app.put('/api/saas/users/:username', authMiddleware, (req,res) => {
  try {
    const { loadUsers, saveUsers } = require('./lib/auth');
    const store = loadUsers();
    const user = store.users.find(u => u.username === req.params.username);
    if (!user) return res.status(404).json({ ok:false, error:'User not found' });
    const { name, role, email, phone, tenant_id, tenant_slug, plant_ids, active } = req.body;
    if (name        !== undefined) user.name        = name;
    if (role        !== undefined) user.role        = role;
    if (email       !== undefined) user.email       = email;
    if (phone       !== undefined) user.phone       = phone;
    if (tenant_id   !== undefined) user.tenant_id   = tenant_id;
    if (tenant_slug !== undefined) user.tenant_slug = tenant_slug;
    if (plant_ids   !== undefined) user.plant_ids   = plant_ids;
    if (active      !== undefined) user.active      = active !== false;
    saveUsers(store);
    db.query(`INSERT INTO saas_audit_log(action,entity,entity_id,details) VALUES('UPDATE','user',$1,$2)`,
      [user.id, `Updated user: ${req.params.username}`]).catch(()=>{});
    const { password_hash: _, ...safe } = user;
    res.json({ ok:true, data: safe });
  } catch(e) { res.status(500).json({ ok:false, error: e.message }); }
});

// DELETE /api/saas/users/:username — deactivate (not hard-delete) unless ?hard=1
app.delete('/api/saas/users/:username', authMiddleware, (req,res) => {
  try {
    const { loadUsers, saveUsers } = require('./lib/auth');
    const store = loadUsers();
    const idx = store.users.findIndex(u => u.username === req.params.username);
    if (idx === -1) return res.status(404).json({ ok:false, error:'User not found' });
    if (req.query.hard === '1') {
      store.users.splice(idx, 1);
    } else {
      store.users[idx].active = false;
    }
    saveUsers(store);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ ok:false, error: e.message }); }
});

// POST /api/saas/users/:username/reset-password
app.post('/api/saas/users/:username/reset-password', authMiddleware, async(req,res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 3) return res.status(400).json({ ok:false, error:'Password must be at least 3 characters' });
    const { updatePassword } = require('./lib/auth');
    await updatePassword(req.params.username, newPassword);
    await db.query(`INSERT INTO saas_audit_log(action,entity,entity_id,details) VALUES('UPDATE','user',$1,$2)`,
      [req.params.username, `Password reset for: ${req.params.username}`]).catch(()=>{});
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ ok:false, error: e.message }); }
});

// Custom report runner
app.post('/api/saas/report', authMiddleware, async(req,res) => {
  try {
    const {source, machine, dateFrom, dateTo, shift, groupBy} = req.body;
    const from = dateFrom ? `${dateFrom}T00:00:00+05:30` : `NOW() - INTERVAL '7 days'`;
    const to   = dateTo   ? `${dateTo}T23:59:59+05:30`   : `NOW()`;
    const mach = machine || 'MACHINE001';
    const shiftCond = shift && shift !== 'Both' ? `AND shift='${shift.replace(/'/g,"''")}'` : '';

    let sql, params;
    if (source === 'oee') {
      sql = `SELECT shift_date::text AS date, shift, ROUND(availability::numeric,1) AS availability,
             ROUND(performance::numeric,1) AS performance, ROUND(quality::numeric,1) AS quality,
             ROUND(oee::numeric,1) AS oee, parts_produced
             FROM oee_results WHERE machine_id=$1 AND shift_date >= $2::date AND shift_date <= $3::date
             ${shiftCond} ORDER BY shift_date DESC, shift`;
      params = [mach, dateFrom||'2000-01-01', dateTo||'2099-12-31'];
    } else if (source === 'cycles') {
      sql = `SELECT time_bucket('1 hour', time) AT TIME ZONE 'Asia/Kolkata' AS bucket,
             ROUND(AVG(last_cycle_time_sec)::numeric,1) AS avg_cycle,
             ROUND(MIN(last_cycle_time_sec)::numeric,1) AS min_cycle,
             ROUND(MAX(last_cycle_time_sec)::numeric,1) AS max_cycle,
             COUNT(*) FILTER(WHERE last_cycle_time_sec>0) AS parts
             FROM cnc_data WHERE machine_id=$1 AND time >= $2::timestamptz AND time < $3::timestamptz
             AND last_cycle_time_sec > 0 AND last_cycle_time_sec < 3600
             GROUP BY 1 ORDER BY 1`;
      params = [mach, from, to];
    } else if (source === 'states') {
      sql = `SELECT time_bucket('1 hour', time) AT TIME ZONE 'Asia/Kolkata' AS bucket,
             machine_state, COUNT(*) AS readings, ROUND(COUNT(*)*5/60.0,1) AS minutes
             FROM cnc_data WHERE machine_id=$1 AND time >= $2::timestamptz AND time < $3::timestamptz
             GROUP BY 1,2 ORDER BY 1,3 DESC`;
      params = [mach, from, to];
    } else if (source === 'downtime') {
      sql = `SELECT shift_date::text AS date, shift, severity, downtime_category,
             ROUND(duration_min::numeric,1) AS duration_min, state, alarm_no, rca_status
             FROM cnc_downtime_rca WHERE machine_id=$1 AND shift_date >= $2::date AND shift_date <= $3::date
             ${shiftCond} ORDER BY shift_date DESC, start_time`;
      params = [mach, dateFrom||'2000-01-01', dateTo||'2099-12-31'];
    } else if (source === 'quality') {
      sql = `SELECT shift_date::text AS date, shift, log_hour, program_no,
             good_parts, rejected_parts, rejection_reason, operator_name
             FROM cnc_rejection_log WHERE machine_id=$1 AND shift_date >= $2::date AND shift_date <= $3::date
             ${shiftCond} ORDER BY shift_date DESC, log_hour`;
      params = [mach, dateFrom||'2000-01-01', dateTo||'2099-12-31'];
    } else if (source === 'alarms') {
      sql = `SELECT time AT TIME ZONE 'Asia/Kolkata' AS time_ist, alarm_no::text, machine_state,
             spindle_speed, feed_rate, program_no
             FROM cnc_data WHERE machine_id=$1 AND alarm_active=true
             AND time >= $2::timestamptz AND time < $3::timestamptz ORDER BY time DESC LIMIT 500`;
      params = [mach, from, to];
    } else {
      return res.status(400).json({ok:false,error:'Unknown source'});
    }

    const r = await dbCNC.query(sql, params).catch(
      async () => await db.query(sql, params)
    );
    const columns = r.fields ? r.fields.map(f=>f.name) : (r.rows[0] ? Object.keys(r.rows[0]) : []);
    res.json({ok:true, columns, rows:r.rows, count:r.rows.length});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// Audit log
app.get('/api/saas/audit', authMiddleware, async(req,res) => {
  try {
    const r = await db.query('SELECT * FROM saas_audit_log ORDER BY created_at DESC LIMIT 100');
    res.json({ok:true,data:r.rows});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// ── Permissions API (superadmin only) ──────────────────────────────
// GET /api/saas/permissions/:tenant_id — page + KPI permissions
app.get('/api/saas/permissions/:tenant_id', authMiddleware, async(req,res) => {
  try {
    const tid = parseInt(req.params.tenant_id);
    const [pages, kpis] = await Promise.all([
      db.query('SELECT * FROM tenant_page_permissions WHERE tenant_id=$1 ORDER BY page_key', [tid]),
      db.query('SELECT * FROM tenant_kpi_permissions  WHERE tenant_id=$1 ORDER BY kpi_key',  [tid]),
    ]);
    res.json({ ok:true, pages: pages.rows, kpis: kpis.rows });
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// PUT /api/saas/permissions/:tenant_id — bulk update
app.put('/api/saas/permissions/:tenant_id', authMiddleware, async(req,res) => {
  try {
    const tid = parseInt(req.params.tenant_id);
    const { pages=[], kpis=[] } = req.body;   // [{page_key, enabled}, ...]
    for (const p of pages) {
      await db.query(
        `INSERT INTO tenant_page_permissions(tenant_id,page_key,enabled,updated_at)
         VALUES($1,$2,$3,NOW())
         ON CONFLICT(tenant_id,page_key) DO UPDATE SET enabled=$3, updated_at=NOW()`,
        [tid, p.page_key, p.enabled !== false]
      );
    }
    for (const k of kpis) {
      await db.query(
        `INSERT INTO tenant_kpi_permissions(tenant_id,kpi_key,enabled,updated_at)
         VALUES($1,$2,$3,NOW())
         ON CONFLICT(tenant_id,kpi_key) DO UPDATE SET enabled=$3, updated_at=NOW()`,
        [tid, k.kpi_key, k.enabled !== false]
      );
    }
    await db.query(`INSERT INTO saas_audit_log(action,entity,entity_id,details)
      VALUES('UPDATE','permissions',$1,$2)`,
      [tid, `Updated ${pages.length} pages, ${kpis.length} KPIs for tenant ${tid}`]).catch(()=>{});
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// GET /api/saas/permissions/mine — returns effective permissions for logged-in user's tenant
app.get('/api/saas/permissions/mine', authMiddleware, async(req,res) => {
  try {
    const tenantId = req.user.tenant_id;
    if (!tenantId) return res.json({ ok:true, pages:[], kpis:[], all_enabled:true });
    const [pages, kpis] = await Promise.all([
      db.query('SELECT page_key, enabled FROM tenant_page_permissions WHERE tenant_id=$1', [tenantId]),
      db.query('SELECT kpi_key,  enabled FROM tenant_kpi_permissions  WHERE tenant_id=$1', [tenantId]),
    ]);
    res.json({ ok:true, pages: pages.rows, kpis: kpis.rows });
  } catch(e) { res.json({ ok:true, pages:[], kpis:[], all_enabled:true }); }
});

// GET /api/saas/isa95/:machine_id — retrieve stored ISA-95 config
app.get('/api/saas/isa95/:machine_id', authMiddleware, async(req,res) => {
  try {
    const r = await db.query(
      `SELECT m.*, p.name AS plant_name, t.name AS tenant_name, t.slug AS tenant_slug
       FROM saas_machines m
       LEFT JOIN saas_plants p ON p.id=m.plant_id
       LEFT JOIN tenants t ON t.id=p.tenant_id
       WHERE m.machine_id=$1 ORDER BY m.id DESC LIMIT 1`, [req.params.machine_id]);
    if (!r.rows[0]) return res.status(404).json({ok:false,error:'Machine not found'});
    const row = r.rows[0];
    let isa95 = row.isa95_config;
    if (!isa95) {
      // Generate on-the-fly if not stored yet
      const plant  = { id:row.plant_id, name:row.plant_name, code:row.machine_id };
      const tenant = { id:row.tenant_id, name:row.tenant_name, slug:row.tenant_slug };
      isa95 = generateISA95Config(row, plant, tenant);
    }
    res.json({ ok:true, isa95_config: isa95 });
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// ═══════════════════════════════════════════════════════════════════
//  REPORT BUILDER API
// ═══════════════════════════════════════════════════════════════════

// ── GET /api/machine-info — dynamic machine + plant + tenant metadata ──────
// Returns real data from saas_machines / saas_plants / tenants so every page
// can render company name, plant location, machine type without hardcoding.
app.get('/api/machine-info', authMiddleware, async (req, res) => {
  const mid = req.query.machine_id || 'MACHINE001';
  try {
    const r = await db.query(
      `SELECT
         m.machine_id,
         COALESCE(m.name, m.machine_id)                    AS machine_name,
         COALESCE(m.type, 'CNC')                            AS machine_type,
         COALESCE(m.make, '')                               AS machine_make,
         COALESCE(m.model, '')                              AS machine_model,
         COALESCE(m.description, '')                        AS machine_description,
         COALESCE(p.name, '—')                              AS plant_name,
         COALESCE(p.location, p.name, '—')                  AS plant_location,
         COALESCE(p.code, '')                               AS plant_code,
         COALESCE(t.name, '—')                              AS tenant_name
       FROM saas_machines m
       LEFT JOIN saas_plants p ON p.id = m.plant_id
       LEFT JOIN tenants t ON t.id = p.tenant_id
       WHERE m.machine_id = $1
       ORDER BY m.id DESC LIMIT 1`,
      [mid]
    );
    if (r.rows[0]) {
      return res.json({ ok: true, ...r.rows[0] });
    }
    // Fallback if machine not in DB yet
    res.json({ ok: true, machine_id: mid, machine_name: mid, machine_type: 'CNC',
               machine_make: '', machine_model: '', machine_description: '',
               plant_name: '—', plant_location: '—', plant_code: '', tenant_name: '—' });
  } catch (e) {
    res.json({ ok: true, machine_id: mid, machine_name: mid, machine_type: 'CNC',
               machine_make: '', machine_model: '', machine_description: '',
               plant_name: '—', plant_location: '—', plant_code: '', tenant_name: '—' });
  }
});

// ── GET /api/reports/machines ─────────────────────────────────────
app.get('/api/reports/machines', authMiddleware, async (req, res) => {
  try {
    const r = await dbCNC.query(`SELECT DISTINCT machine_id FROM cnc_data ORDER BY machine_id`);
    const list = r.rows.map(row => row.machine_id);
    if (!list.length) list.push('MACHINE001');
    res.json({ ok: true, machines: list });
  } catch(e) {
    res.json({ ok: true, machines: ['MACHINE001'] });
  }
});

// ── GET /api/reports/programs ──────────────────────────────────────
app.get('/api/reports/programs', authMiddleware, async (req, res) => {
  try {
    const machine = req.query.machine_id || 'MACHINE001';
    const r = await dbCNC.query(
      `SELECT program_no, part_name, ROUND(target_cycle_sec::numeric,1) AS target_cycle_sec
       FROM program_master WHERE machine_id=$1 AND program_no IS NOT NULL
       ORDER BY program_no`,
      [machine]
    );
    res.json({ ok: true, programs: r.rows });
  } catch(e) {
    res.json({ ok: true, programs: [] });
  }
});

// ── GET /api/reports/query — dynamic report from DB ───────────────
app.get('/api/reports/query', authMiddleware, async (req, res) => {
  const {
    type      = 'shift',
    machine_id = 'MACHINE001',
    date_from,
    date_to,
    shift     = 'both',
    program_no,
    page_size = '500',
    cursor,          // ISO timestamp — cursor-based pagination for raw type
    time_from,       // HH:MM IST — optional sub-day start time (hourly/raw only)
    time_to,         // HH:MM IST — optional sub-day end time   (hourly/raw only)
  } = req.query;

  const from     = date_from || new Date(Date.now() - 7*86400000).toISOString().slice(0,10);
  const to       = date_to   || new Date().toISOString().slice(0,10);
  const pageSize = Math.min(2000, Math.max(50, parseInt(page_size) || 500));

  // Build IST time-of-day filter (applied to hourly + raw cnc_data queries)
  // Validates format HH:MM to avoid SQL injection
  const validTime = /^\d{2}:\d{2}$/;
  const safeTimeFrom = (time_from && validTime.test(time_from)) ? time_from : null;
  const safeTimeTo   = (time_to   && validTime.test(time_to))   ? time_to   : null;
  // SQL fragment: filters on the IST time-of-day component
  const timeOfDayFilter =
    (safeTimeFrom && safeTimeTo)
      ? `AND (time AT TIME ZONE 'Asia/Kolkata')::time >= '${safeTimeFrom}'::time
         AND (time AT TIME ZONE 'Asia/Kolkata')::time <  '${safeTimeTo}'::time`
    : safeTimeFrom
      ? `AND (time AT TIME ZONE 'Asia/Kolkata')::time >= '${safeTimeFrom}'::time`
    : safeTimeTo
      ? `AND (time AT TIME ZONE 'Asia/Kolkata')::time <  '${safeTimeTo}'::time`
    : '';

  try {
    let rows = [], totalCount = 0;

    // ── RAW — individual rows from cnc_data (cursor-based, no OFFSET) ─
    if (type === 'raw') {
      // Build shift hour filter using pre-computed IST hour column for speed
      // We pre-cast to IST once in a CTE so EXTRACT only runs once per row
      const shiftHourCond =
        shift === 'A' ? 'AND ist_hour BETWEEN 7 AND 18' :
        shift === 'B' ? 'AND (ist_hour >= 19 OR ist_hour < 7)' : '';
      const progFilter = program_no ? `AND program_no = '${program_no.replace(/'/g,"''")}'` : '';
      // Cursor: timestamp of last row from previous page (avoids slow OFFSET)
      const cursorFilter = cursor ? `AND time < '${cursor.replace(/'/g,"''")}'::timestamptz` : '';

      // Efficient CTE: filter date range first (uses index), compute IST hour once
      const sql = `
        WITH base AS (
          SELECT time,
                 EXTRACT(HOUR FROM time AT TIME ZONE 'Asia/Kolkata')::int AS ist_hour,
                 machine_state, is_running, part_count,
                 last_cycle_time_sec, raw_cycle_time_sec,
                 spindle_speed, feed_rate, alarm_active, alarm_no,
                 program_no, run_status
          FROM cnc_data
          WHERE machine_id = $1
            AND time >= $2::date AT TIME ZONE 'Asia/Kolkata'
            AND time <  ($3::date + interval '1 day') AT TIME ZONE 'Asia/Kolkata'
            ${cursorFilter}
        )
        SELECT
          to_char(time AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS')  AS timestamp,
          time                                                                  AS raw_time,
          COALESCE(machine_state::text, '')                                    AS machine_state,
          CASE WHEN is_running THEN 'Yes' ELSE 'No' END                        AS is_running,
          COALESCE(part_count, 0)                                              AS part_count,
          ROUND(COALESCE(last_cycle_time_sec, 0)::numeric, 1)                 AS last_cycle_sec,
          ROUND(COALESCE(raw_cycle_time_sec, 0)::numeric, 1)                  AS raw_cycle_sec,
          ROUND(COALESCE(spindle_speed, 0)::numeric, 0)                       AS spindle_speed,
          ROUND(COALESCE(feed_rate, 0)::numeric, 0)                           AS feed_rate,
          CASE WHEN alarm_active THEN 'YES' ELSE '' END                        AS alarm_active,
          COALESCE(alarm_no::text, '')                                         AS alarm_no,
          COALESCE(program_no::text, '')                                       AS program_no,
          COALESCE(run_status::text, '')                                       AS run_status
        FROM base
        WHERE true ${shiftHourCond} ${progFilter} ${timeOfDayFilter}
        ORDER BY time DESC
        LIMIT $4`;

      const r = await dbCNC.query(sql, [machine_id, from, to, pageSize]);
      rows = r.rows;

      // Next-page cursor = raw_time of last row (oldest in this batch)
      const nextCursor = rows.length === pageSize
        ? rows[rows.length - 1].raw_time
        : null;

      const summary = {};
      const numCols = ['part_count','last_cycle_sec','raw_cycle_sec','spindle_speed','feed_rate'];
      numCols.forEach(k => {
        const vals = rows.map(r => parseFloat(r[k])).filter(v => !isNaN(v) && v > 0);
        if (vals.length) summary[k] = {
          avg: Math.round(vals.reduce((a,b)=>a+b,0)/vals.length*10)/10,
          min: Math.round(Math.min(...vals)*10)/10,
          max: Math.round(Math.max(...vals)*10)/10,
        };
      });

      return res.json({ ok:true, rows, summary, type, machine_id, from, to,
        count: rows.length, page_size: pageSize,
        has_more: nextCursor !== null,
        next_cursor: nextCursor ? nextCursor.toISOString() : null });
    }

    // ── HOURLY — from cnc_data with program_master JOIN ───────────
    if (type === 'hourly') {
      // Build shift filter using pre-computed IST hour in a CTE for index efficiency
      const shiftHourCond =
        shift === 'A' ? 'AND ist_hour BETWEEN 7 AND 18' :
        shift === 'B' ? 'AND (ist_hour >= 19 OR ist_hour < 7)' : '';
      const progFilter = program_no ? `AND program_no = '${program_no.replace(/'/g,"''")}'` : '';

      const sql = `
        WITH base AS (
          SELECT
            date_trunc('hour', time AT TIME ZONE 'Asia/Kolkata') AS hour_ist,
            EXTRACT(HOUR FROM time AT TIME ZONE 'Asia/Kolkata')::int AS ist_hour,
            spindle_speed, feed_rate, last_cycle_time_sec,
            is_running, alarm_active, part_count, program_no
          FROM cnc_data
          WHERE machine_id = $1
            AND time >= $2::date AT TIME ZONE 'Asia/Kolkata'
            AND time <  ($3::date + interval '1 day') AT TIME ZONE 'Asia/Kolkata'
            ${progFilter}
        ),
        hourly AS (
          SELECT
            to_char(hour_ist, 'YYYY-MM-DD HH24:00')                              AS period,
            to_char(hour_ist, 'DD-Mon HH24:00')                                  AS hour_label,
            COUNT(*)::int                                                          AS readings,
            ROUND(AVG(NULLIF(spindle_speed,0))::numeric, 0)                       AS avg_spindle_speed,
            ROUND(AVG(NULLIF(feed_rate,0))::numeric, 0)                           AS avg_feed_rate,
            ROUND(AVG(CASE WHEN last_cycle_time_sec > 2 THEN last_cycle_time_sec END)::numeric, 1) AS avg_cycle_sec,
            ROUND(MIN(CASE WHEN last_cycle_time_sec > 2 THEN last_cycle_time_sec END)::numeric, 1) AS min_cycle_sec,
            ROUND(MAX(CASE WHEN last_cycle_time_sec > 2 THEN last_cycle_time_sec END)::numeric, 1) AS max_cycle_sec,
            ROUND(100.0 * SUM(CASE WHEN is_running THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*),0), 1) AS running_pct,
            ROUND(100.0 * SUM(CASE WHEN NOT is_running THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*),0), 1) AS idle_pct,
            SUM(CASE WHEN alarm_active THEN 1 ELSE 0 END)::int                    AS alarm_count,
            GREATEST(0, MAX(part_count) - MIN(part_count))::int                   AS parts_produced,
            MODE() WITHIN GROUP (ORDER BY program_no)                             AS top_program_no
          FROM base
          WHERE true ${shiftHourCond} ${timeOfDayFilter}
          GROUP BY hour_ist
          ORDER BY hour_ist DESC
          LIMIT 500
        )
        SELECT h.*,
          CASE WHEN h.top_program_no IS NOT NULL
               THEN 'O' || lpad(h.top_program_no::text, 4, '0')
               ELSE '' END                                  AS program_label,
          COALESCE(pm.part_name, '')                        AS part_name,
          COALESCE(pm.target_cycle_sec, 0)                  AS target_cycle_sec,
          CASE WHEN pm.target_cycle_sec > 0 AND h.avg_cycle_sec > 0
               THEN ROUND(100.0 * pm.target_cycle_sec / h.avg_cycle_sec, 1)
               ELSE NULL END                                AS cycle_efficiency
        FROM hourly h
        LEFT JOIN program_master pm
          ON pm.program_no = h.top_program_no AND pm.machine_id = $1`;

      const r = await dbCNC.query(sql, [machine_id, from, to]);
      rows = r.rows;

    // ── SHIFT — one row per shift from oee_results + dominant program from cnc_data ──
    } else if (type === 'shift') {
      const shiftWhere = (shift === 'both') ? '' : `AND o.shift = '${shift === 'A' ? 'A' : 'B'}'`;
      const progWhere  = program_no
        ? `AND EXISTS(SELECT 1 FROM cnc_data c2 WHERE c2.machine_id=o.machine_id AND c2.time::date=o.shift_date AND c2.program_no='${program_no.replace(/'/g,"''")}' LIMIT 1)`
        : '';
      // CTE tp: compute dominant program_no per shift from cnc_data
      const sql = `
        WITH tp AS (
          SELECT
            CASE WHEN EXTRACT(HOUR FROM time AT TIME ZONE 'Asia/Kolkata') < 7
                 THEN (time AT TIME ZONE 'Asia/Kolkata')::date - 1
                 ELSE (time AT TIME ZONE 'Asia/Kolkata')::date END        AS c_shift_date,
            CASE WHEN EXTRACT(HOUR FROM time AT TIME ZONE 'Asia/Kolkata') BETWEEN 7 AND 18
                 THEN 'A' ELSE 'B' END                                    AS c_shift,
            MODE() WITHIN GROUP (ORDER BY program_no)                     AS top_program_no,
            COUNT(DISTINCT program_no)                                    AS program_count
          FROM cnc_data
          WHERE machine_id = $1
            AND time >= $2::date AT TIME ZONE 'Asia/Kolkata'
            AND time <  ($3::date + INTERVAL '2 days') AT TIME ZONE 'Asia/Kolkata'
            AND program_no IS NOT NULL
          GROUP BY 1, 2
        )
        SELECT
          o.shift_date, o.shift, o.machine_id,
          o.shift_date::text || ' Sh.' || o.shift ||
            CASE o.shift
              WHEN 'A' THEN ' (07:00→19:00)'
              WHEN 'B' THEN ' (19:00→07:00+1)'
              ELSE '' END                                      AS period,
          CASE o.shift WHEN 'A' THEN '07:00' WHEN 'B' THEN '19:00' END   AS shift_from,
          CASE o.shift WHEN 'A' THEN '19:00' WHEN 'B' THEN '07:00+1' END AS shift_to,
          ROUND(o.oee::numeric,1)                              AS oee,
          ROUND(o.availability::numeric,1)                     AS availability,
          ROUND(o.performance::numeric,1)                      AS performance,
          ROUND(o.quality::numeric,1)                          AS quality,
          o.parts_produced, o.target_parts, o.good_parts, o.rejection_count,
          COALESCE(ROUND(o.parts_attainment::numeric,1),
            CASE WHEN o.target_parts>0 THEN ROUND(100.0*o.parts_produced/o.target_parts,1) END) AS attainment_pct,
          ROUND(COALESCE(o.scrap_rate,0)::numeric,2)           AS scrap_rate,
          ROUND(o.avg_cycle_sec::numeric,1)                    AS avg_cycle_sec,
          ROUND(o.best_cycle_sec::numeric,1)                   AS best_cycle_sec,
          ROUND(o.worst_cycle_sec::numeric,1)                  AS worst_cycle_sec,
          ROUND(o.target_cycle_sec::numeric,1)                 AS target_cycle_sec,
          ROUND(COALESCE(o.cycle_efficiency,0)::numeric,1)     AS cycle_efficiency,
          ROUND(COALESCE(o.running_min, o.running_sec/60.0)::numeric,1)  AS running_min,
          ROUND(COALESCE(o.downtime_min, o.downtime_sec/60.0)::numeric,1) AS downtime_min,
          ROUND(COALESCE(o.major_downtime_min, o.major_downtime_sec/60.0, 0)::numeric,1) AS major_downtime_min,
          ROUND(COALESCE(o.minor_downtime_min, o.minor_downtime_sec/60.0, 0)::numeric,1) AS minor_downtime_min,
          ROUND(COALESCE(o.idle_sec,0)/60.0,1)                 AS idle_min,
          o.alarm_count,
          CASE WHEN tp.top_program_no IS NOT NULL
               THEN 'O' || lpad(tp.top_program_no::text, 4, '0')
               ELSE '—' END                                    AS program_label,
          COALESCE(pm.part_name, '—')                          AS part_name,
          COALESCE(pm.target_cycle_sec, 0)                     AS pgm_target_cycle,
          COALESCE(tp.program_count, 0)                        AS program_count
        FROM oee_results o
        LEFT JOIN tp ON tp.c_shift_date = o.shift_date AND tp.c_shift = o.shift
        LEFT JOIN program_master pm
          ON pm.program_no = tp.top_program_no AND pm.machine_id = o.machine_id
        WHERE o.machine_id=$1 AND o.shift_date BETWEEN $2 AND $3
          ${shiftWhere} ${progWhere}
        ORDER BY o.shift_date DESC, o.shift
        LIMIT 1000`;
      const r = await dbCNC.query(sql, [machine_id, from, to]);
      rows = r.rows;

    // ── DAILY / WEEKLY / MONTHLY — aggregated from oee_results + dominant program ──
    } else {
      const shiftWhere = (shift === 'both') ? '' : `AND shift = '${shift === 'A' ? 'A' : 'B'}'`;
      const grp =
        type === 'daily'   ? 'shift_date' :
        type === 'weekly'  ? `date_trunc('week', shift_date)` :
                             `date_trunc('month', shift_date)`;
      const periodExpr =
        type === 'daily'   ? `shift_date::text` :
        type === 'weekly'  ? `to_char(date_trunc('week', shift_date),'YYYY-MM-DD') || ' (wk)'` :
                             `to_char(date_trunc('month',shift_date),'Mon YYYY')`;
      // Grouping function applied to c_shift_date in CTE to match the oee_results period key
      const truncFn =
        type === 'daily'   ? `c_shift_date` :
        type === 'weekly'  ? `date_trunc('week',  c_shift_date)` :
                             `date_trunc('month', c_shift_date)`;

      const sql = `
        WITH tp AS (
          -- Compute IST shift date for each cnc_data row
          SELECT
            CASE WHEN EXTRACT(HOUR FROM time AT TIME ZONE 'Asia/Kolkata') < 7
                 THEN (time AT TIME ZONE 'Asia/Kolkata')::date - 1
                 ELSE (time AT TIME ZONE 'Asia/Kolkata')::date END AS c_shift_date,
            program_no
          FROM cnc_data
          WHERE machine_id = $1
            AND time >= $2::date AT TIME ZONE 'Asia/Kolkata'
            AND time <  ($3::date + INTERVAL '2 days') AT TIME ZONE 'Asia/Kolkata'
            AND program_no IS NOT NULL
        ),
        tp_grp AS (
          -- Dominant program per period bucket
          SELECT
            ${truncFn}                                              AS trunc_period,
            MODE() WITHIN GROUP (ORDER BY program_no)              AS top_program_no,
            COUNT(DISTINCT program_no)                             AS program_count
          FROM tp
          GROUP BY 1
        ),
        agg AS (
          -- Standard oee_results aggregation
          SELECT
            ${grp}                                                  AS period_key,
            ${periodExpr}                                           AS period,
            COUNT(*)                                                AS shifts,
            ROUND(AVG(oee)::numeric,1)                             AS oee,
            ROUND(AVG(availability)::numeric,1)                    AS availability,
            ROUND(AVG(performance)::numeric,1)                     AS performance,
            ROUND(AVG(quality)::numeric,1)                         AS quality,
            SUM(parts_produced)                                    AS parts_produced,
            SUM(target_parts)                                      AS target_parts,
            SUM(good_parts)                                        AS good_parts,
            SUM(rejection_count)                                   AS rejection_count,
            CASE WHEN SUM(target_parts)>0
                 THEN ROUND(100.0*SUM(parts_produced)/SUM(target_parts),1) END AS attainment_pct,
            ROUND(AVG(NULLIF(scrap_rate,0))::numeric,2)            AS scrap_rate,
            ROUND(AVG(NULLIF(avg_cycle_sec,0))::numeric,1)         AS avg_cycle_sec,
            ROUND(MIN(NULLIF(best_cycle_sec,0))::numeric,1)        AS best_cycle_sec,
            ROUND(MAX(NULLIF(worst_cycle_sec,0))::numeric,1)       AS worst_cycle_sec,
            ROUND(AVG(NULLIF(target_cycle_sec,0))::numeric,1)      AS target_cycle_sec,
            ROUND(AVG(NULLIF(cycle_efficiency,0))::numeric,1)      AS cycle_efficiency,
            ROUND(SUM(COALESCE(running_min,  running_sec/60.0)),1) AS running_min,
            ROUND(SUM(COALESCE(downtime_min, downtime_sec/60.0)),1) AS downtime_min,
            ROUND(SUM(COALESCE(major_downtime_min, major_downtime_sec/60.0, 0)),1) AS major_downtime_min,
            ROUND(SUM(COALESCE(minor_downtime_min, minor_downtime_sec/60.0, 0)),1) AS minor_downtime_min,
            ROUND(SUM(COALESCE(idle_sec,0)/60.0),1)                AS idle_min,
            SUM(alarm_count)                                       AS alarm_count
          FROM oee_results
          WHERE machine_id=$1 AND shift_date BETWEEN $2 AND $3
            ${shiftWhere}
          GROUP BY ${grp}
        )
        SELECT
          a.*,
          CASE WHEN tg.top_program_no IS NOT NULL
               THEN 'O' || lpad(tg.top_program_no::text, 4, '0')
               ELSE '—' END                                        AS program_label,
          COALESCE(pm.part_name, '—')                              AS part_name,
          COALESCE(pm.target_cycle_sec, 0)                         AS pgm_target_cycle,
          COALESCE(tg.program_count, 0)                            AS program_count
        FROM agg a
        LEFT JOIN tp_grp tg ON a.period_key = tg.trunc_period
        LEFT JOIN program_master pm
          ON pm.program_no = tg.top_program_no AND pm.machine_id = $1
        ORDER BY a.period_key DESC
        LIMIT 500`;
      const r = await dbCNC.query(sql, [machine_id, from, to]);
      rows = r.rows;
    }

    // ── Program breakdown — parallel query for all non-raw types ───
    let program_breakdown = [];
    let program_log       = [];
    try {
      const shiftTimeFilter =
        shift === 'A'
          ? `AND time >= $2::date AT TIME ZONE 'Asia/Kolkata'
             AND time <  ($3::date + interval '1 day') AT TIME ZONE 'Asia/Kolkata'
             AND EXTRACT(HOUR FROM time AT TIME ZONE 'Asia/Kolkata') BETWEEN 7 AND 18`
          : shift === 'B'
          ? `AND time >= $2::date AT TIME ZONE 'Asia/Kolkata'
             AND time <  ($3::date + interval '2 days') AT TIME ZONE 'Asia/Kolkata'
             AND (EXTRACT(HOUR FROM time AT TIME ZONE 'Asia/Kolkata') >= 19
                  OR EXTRACT(HOUR FROM time AT TIME ZONE 'Asia/Kolkata') < 7)`
          : `AND time >= $2::date AT TIME ZONE 'Asia/Kolkata'
             AND time <  ($3::date + interval '1 day') AT TIME ZONE 'Asia/Kolkata'`;

      const pbSql = `
        SELECT
          cd.program_no,
          CASE WHEN cd.program_no IS NOT NULL
               THEN 'O' || lpad(cd.program_no::text, 4, '0')
               ELSE '—' END                                  AS program_label,
          COALESCE(pm.part_name, 'Unknown')                   AS part_name,
          COALESCE(pm.target_cycle_sec, 0)                    AS target_cycle_sec,
          COUNT(*)                                            AS readings,
          COUNT(CASE WHEN cd.last_cycle_time_sec > 2 THEN 1 END) AS cycles,
          ROUND(AVG(CASE WHEN cd.last_cycle_time_sec > 2 THEN cd.last_cycle_time_sec END)::numeric, 1) AS avg_cycle_sec,
          ROUND(MIN(CASE WHEN cd.last_cycle_time_sec > 2 THEN cd.last_cycle_time_sec END)::numeric, 1) AS best_cycle_sec,
          ROUND(MAX(CASE WHEN cd.last_cycle_time_sec > 2 THEN cd.last_cycle_time_sec END)::numeric, 1) AS worst_cycle_sec,
          CASE WHEN COALESCE(pm.target_cycle_sec,0) > 0
               AND AVG(CASE WHEN cd.last_cycle_time_sec > 2 THEN cd.last_cycle_time_sec END) > 0
               THEN ROUND(100.0 * pm.target_cycle_sec /
                     AVG(CASE WHEN cd.last_cycle_time_sec > 2 THEN cd.last_cycle_time_sec END), 1)
               ELSE NULL END                                  AS cycle_efficiency,
          to_char(MIN(cd.time AT TIME ZONE 'Asia/Kolkata'), 'DD-Mon HH24:MI') AS first_seen,
          to_char(MAX(cd.time AT TIME ZONE 'Asia/Kolkata'), 'DD-Mon HH24:MI') AS last_seen
        FROM cnc_data cd
        LEFT JOIN program_master pm
          ON pm.program_no = cd.program_no AND pm.machine_id = $1
        WHERE cd.machine_id = $1
          AND cd.program_no IS NOT NULL
          ${shiftTimeFilter}
        GROUP BY cd.program_no, pm.part_name, pm.target_cycle_sec
        ORDER BY readings DESC
        LIMIT 20`;

      const pbResult = await dbCNC.query(pbSql, [machine_id, from, to]);
      program_breakdown = pbResult.rows;

      // Program change log — only for ≤14 day ranges (avoids heavy scans)
      const daysDiff = (new Date(to) - new Date(from)) / 86400000;
      if (daysDiff <= 14) {
        const plSql = `
          WITH ordered AS (
            SELECT
              time,
              program_no,
              LAG(program_no) OVER (ORDER BY time) AS prev_program_no
            FROM cnc_data
            WHERE machine_id = $1
              ${shiftTimeFilter}
              AND program_no IS NOT NULL
          )
          SELECT
            to_char(time AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') AS changed_at,
            'O' || lpad(prev_program_no::text, 4, '0')   AS from_label,
            'O' || lpad(program_no::text, 4, '0')         AS to_label,
            prev_program_no,
            program_no AS new_program_no
          FROM ordered
          WHERE program_no IS DISTINCT FROM prev_program_no
            AND prev_program_no IS NOT NULL
          ORDER BY time ASC
          LIMIT 200`;
        const plResult = await dbCNC.query(plSql, [machine_id, from, to]);
        program_log = plResult.rows;
      }
    } catch(pbErr) {
      console.warn('program_breakdown query warning:', pbErr.message);
    }

    // ── Compute summary stats (avg / min / max per numeric column) ──
    const summary = {};
    if (rows.length > 0) {
      const skip = new Set(['period','period_key','shift_date','shift','machine_id',
                            'program_no','top_program','program_label','part_name',
                            'hour_label','shift_from','shift_to']);
      Object.keys(rows[0]).forEach(k => {
        if (skip.has(k)) return;
        const vals = rows.map(r => parseFloat(r[k])).filter(v => !isNaN(v));
        if (!vals.length) return;
        summary[k] = {
          avg: Math.round(vals.reduce((a,b) => a+b, 0) / vals.length * 10) / 10,
          min: Math.round(Math.min(...vals) * 10) / 10,
          max: Math.round(Math.max(...vals) * 10) / 10,
          sum: Math.round(vals.reduce((a,b) => a+b, 0) * 10) / 10,
        };
      });
    }

    res.json({ ok: true, rows, summary, type, machine_id, from, to,
               time_from: safeTimeFrom || null, time_to: safeTimeTo || null,
               count: rows.length, program_breakdown, program_log });
  } catch(e) {
    console.error('/api/reports/query error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Published Dashboards store ───────────────────────────────────
const PUBLISHED_DASH_PATH = path.join(__dirname, 'config', 'published-dashboards.json');

function loadPublishedDashboards() {
  try { return JSON.parse(fs.readFileSync(PUBLISHED_DASH_PATH, 'utf8')); }
  catch { return []; }
}
function savePublishedDashboards(list) {
  fs.writeFileSync(PUBLISHED_DASH_PATH, JSON.stringify(list, null, 2));
}

// ── GET /api/saas/plants-list — public endpoint for KPI builder dropdown ──
// Returns plants from saas_plants + machines from saas_machines in the
// same {registry:{plants:[]}} shape used by device_registry.json consumers.
const CNC_PARAMETERS = [
  { field:'spindle_speed',  label:'Spindle Speed',  unit:'RPM',    kpi_type:'live'     },
  { field:'feed_rate',      label:'Feed Rate',       unit:'mm/min', kpi_type:'live'     },
  { field:'parts_made',     label:'Parts Made',      unit:'pcs',    kpi_type:'count'    },
  { field:'cycle_time_sec', label:'Cycle Time',      unit:'sec',    kpi_type:'duration' },
  { field:'spindle_load',   label:'Spindle Load',    unit:'%',      kpi_type:'percent'  },
  { field:'servo_load',     label:'Servo Load',      unit:'%',      kpi_type:'percent'  },
  { field:'power_kw',       label:'Power (kW)',       unit:'kW',     kpi_type:'live'     },
  { field:'temperature',    label:'Temperature',     unit:'°C',     kpi_type:'live'     },
  { field:'vibration_x',   label:'Vibration X',     unit:'g',      kpi_type:'live'     },
  { field:'alarm_code',     label:'Alarm Code',      unit:'',       kpi_type:'status'   },
  { field:'machine_state',  label:'Machine State',   unit:'',       kpi_type:'status'   },
  { field:'program_no',     label:'Program No',      unit:'',       kpi_type:'text'     },
];

app.get('/api/saas/plants-list', async (req, res) => {
  cors(res);
  try {
    const pr = await db.query(`SELECT id, name, code FROM saas_plants WHERE status='active' ORDER BY id`);
    const plants = await Promise.all(pr.rows.map(async (p) => {
      const mr = await db.query(
        `SELECT machine_id, name, type FROM saas_machines WHERE plant_id=$1 ORDER BY id`, [p.id]
      );
      const devices = mr.rows.map(m => ({
        device_id:   m.machine_id,
        device_name: m.name,
        device_type: m.type || 'CNC',
        parameters:  CNC_PARAMETERS,
      }));
      return { plant_id: String(p.id), plant_name: p.name, plant_code: p.code, devices };
    }));
    res.json({ ok: true, registry: { plants } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET  /api/dashboards/list ─────────────────────────────────────
app.get('/api/dashboards/list', (req, res) => {
  cors(res);
  res.json({ ok: true, dashboards: loadPublishedDashboards() });
});

// ── POST /api/dashboards/publish ──────────────────────────────────
app.post('/api/dashboards/publish', (req, res) => {
  cors(res);
  const { name, description, visibility, widgets, slug: reqSlug, columns } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  const slug = (reqSlug || name)
    .toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const list = loadPublishedDashboards();
  const idx  = list.findIndex(d => d.slug === slug);
  const entry = {
    slug,
    name,
    description: description || '',
    visibility:  visibility  || 'all',
    widgets:     widgets     || [],
    columns:     parseInt(columns) || 3,
    theme:       req.body.theme || {},
    published_at: new Date().toISOString(),
    url: '/view/' + slug,
  };
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  savePublishedDashboards(list);
  res.json({ ok: true, dashboard: entry });
});

// ── DELETE /api/dashboards/:slug ──────────────────────────────────
app.delete('/api/dashboards/:slug', (req, res) => {
  cors(res);
  const list = loadPublishedDashboards().filter(d => d.slug !== req.params.slug);
  savePublishedDashboards(list);
  res.json({ ok: true });
});

// ── GET /view/:slug — serve published dashboard viewer page ───────
app.get('/view/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'view.html'));
});

// ── GET /api/tb/push-oee — manually trigger OEE push to ThingsBoard ──
// Useful for testing. Open in browser: http://localhost:3000/api/tb/push-oee
app.get('/api/tb/push-oee', async (req, res) => {
  try {
    const todayIST = getISTShiftDate(); // overnight-safe shift date

    const r = await dbCNC.query(`
      SELECT shift,
        ROUND(oee::numeric,          1) AS oee,
        ROUND(availability::numeric, 1) AS availability,
        ROUND(performance::numeric,  1) AS performance,
        ROUND(quality::numeric,      1) AS quality,
        COALESCE(parts_produced,     0) AS parts_produced,
        COALESCE(target_parts,       0) AS target_parts,
        COALESCE(good_parts,         0) AS good_parts,
        COALESCE(rejection_count,    0) AS rejection_count,
        COALESCE(parts_attainment,   0) AS attainment_pct,
        COALESCE(cycle_efficiency,   0) AS cycle_efficiency,
        COALESCE(running_min,        0) AS running_min,
        COALESCE(downtime_min,       0) AS downtime_min,
        COALESCE(alarm_count,        0) AS alarm_count,
        COALESCE(avg_cycle_sec,      0) AS avg_cycle_sec,
        COALESCE(target_cycle_sec,  45) AS target_cycle_sec
      FROM oee_results
      WHERE machine_id = $1 AND shift_date = $2
      ORDER BY shift
    `, [TB_MACHINE, todayIST]);

    if (!r.rows.length) {
      return res.json({ ok: false, message: `No oee_results rows for machine=${TB_MACHINE} date=${todayIST}`, hint: 'Run populate_oee_today() or check your oee_results table' });
    }

    const payload = {};
    let sumParts = 0, sumTarget = 0, sumGood = 0, sumRej = 0;
    let sumOEE = 0, sumAvail = 0, sumPerf = 0, sumQual = 0, n = 0;

    for (const row of r.rows) {
      const s = row.shift.toLowerCase();
      payload[`oee_shift_${s}`]          = +parseFloat(row.oee          || 0).toFixed(1);
      payload[`availability_shift_${s}`] = +parseFloat(row.availability || 0).toFixed(1);
      payload[`performance_shift_${s}`]  = +parseFloat(row.performance  || 0).toFixed(1);
      payload[`quality_shift_${s}`]      = +parseFloat(row.quality      || 0).toFixed(1);
      payload[`parts_shift_${s}`]        = parseInt(row.parts_produced)  || 0;
      payload[`target_shift_${s}`]       = parseInt(row.target_parts)    || 0;
      payload[`good_parts_shift_${s}`]   = parseInt(row.good_parts)      || 0;
      payload[`rejections_shift_${s}`]   = parseInt(row.rejection_count) || 0;
      payload[`attainment_shift_${s}`]   = +parseFloat(row.attainment_pct   || 0).toFixed(1);
      payload[`cycle_eff_shift_${s}`]    = +parseFloat(row.cycle_efficiency || 0).toFixed(1);
      payload[`running_min_shift_${s}`]  = +parseFloat(row.running_min   || 0).toFixed(1);
      payload[`downtime_min_shift_${s}`] = +parseFloat(row.downtime_min  || 0).toFixed(1);
      payload[`alarms_shift_${s}`]       = parseInt(row.alarm_count)     || 0;
      payload[`avg_cycle_shift_${s}`]    = +parseFloat(row.avg_cycle_sec || 0).toFixed(1);
      payload[`target_cycle_shift_${s}`] = +parseFloat(row.target_cycle_sec || 45).toFixed(1);

      sumParts  += parseInt(row.parts_produced)  || 0;
      sumTarget += parseInt(row.target_parts)    || 0;
      sumGood   += parseInt(row.good_parts)      || 0;
      sumRej    += parseInt(row.rejection_count) || 0;
      sumOEE    += parseFloat(row.oee   || 0);
      sumAvail  += parseFloat(row.availability || 0);
      sumPerf   += parseFloat(row.performance  || 0);
      sumQual   += parseFloat(row.quality      || 0);
      n++;
    }

    payload['parts_today']          = sumParts;
    payload['target_today']         = sumTarget;
    payload['good_parts_today']     = sumGood;
    payload['rejections_today']     = sumRej;
    payload['oee_today']            = n ? +((sumOEE   / n).toFixed(1)) : 0;
    payload['availability_today']   = n ? +((sumAvail / n).toFixed(1)) : 0;
    payload['performance_today']    = n ? +((sumPerf  / n).toFixed(1)) : 0;
    payload['quality_today']        = n ? +((sumQual  / n).toFixed(1)) : 0;
    payload['attainment_today']     = sumTarget > 0 ? +(((sumParts / sumTarget) * 100).toFixed(1)) : 0;
    payload['rejection_rate_today'] = sumParts  > 0 ? +(((sumRej  / sumParts)  * 100).toFixed(2)) : 0;
    payload['oee_zone']             = payload['oee_today'] >= 75 ? 'green'
                                    : payload['oee_today'] >= 50 ? 'amber' : 'red';

    // Push to TB PE
    const tbResp = await fetch(TB_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      timeout: 10000,
    });

    const tbStatus = tbResp.status;
    const tbOk     = tbResp.ok;
    const tbBody   = await tbResp.text().catch(() => '');

    res.json({
      ok:         tbOk,
      tb_status:  tbStatus,
      tb_url:     TB_URL,
      keys_sent:  Object.keys(payload).length,
      shifts:     r.rows.length,
      date:       todayIST,
      machine:    TB_MACHINE,
      oee_today:  payload['oee_today'],
      parts_today: payload['parts_today'],
      payload,
      tb_response: tbBody || '(empty — 200 OK is normal for TB PE)',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/shift-report/send-now — manual test trigger ──────────
// Usage: http://localhost:3000/api/shift-report/send-now?shift=A
//        http://localhost:3000/api/shift-report/send-now?shift=B
app.get('/api/shift-report/send-now', async (req, res) => {
  cors(res);
  try {
    const shift     = (req.query.shift || 'A').toUpperCase();
    const shiftDate = req.query.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    if (!['A','B'].includes(shift)) return res.status(400).json({ error: 'shift must be A or B' });

    const store = loadAlertStore();
    if (!store.smtp || !store.smtp.host) {
      return res.status(400).json({ error: 'SMTP not configured. Go to Alerts → Settings → Email to add Outlook credentials.' });
    }

    await dbCNC.query(`SELECT populate_oee_today()`).catch(() => {});
    const { sendShiftReportEmail } = require('./lib/mailer');
    const report = await buildShiftReport(shift, shiftDate);
    const info   = await sendShiftReportEmail({ smtp: store.smtp, to: SHIFT_REPORT_TO, report });

    res.json({
      ok: true,
      message: `Shift ${shift} report sent for ${shiftDate}`,
      to: SHIFT_REPORT_TO,
      oee: report.oee,
      parts: report.partsProd,
      programs: report.programs.length,
      messageId: info.messageId,
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n  ✅ Factory-MIOS Dashboard → http://localhost:${PORT}`);
  console.log(`  🏭 Plant Manager         → http://localhost:${PORT}/plants`);
  console.log(`  🔧 Device Setup Wizard   → http://localhost:${PORT}/device-setup`);
  console.log(`  🧩 Widget Library        → http://localhost:${PORT}/widgets`);
  console.log(`  🔔 Alerts & Schedules    → http://localhost:${PORT}/alerts\n`);

  // Start alert engine
  alertEngine.start({
    db,
    loadAlertRules,
    getCachedData: () => cachedData,
  });

  // Push OEE to ThingsBoard PE 30 seconds after startup
  // (gives DB time to finish populate_oee_today on boot)
  setTimeout(() => {
    console.log('[TB] Initial OEE push on startup...');
    pushOEEToThingsBoard();
  }, 30 * 1000);
});

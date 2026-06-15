'use strict';

/**
 * Factory-MIOS first-run setup wizard
 * Plant unique id  ??? PostgreSQL schema name
 * Machine unique id ??? table name under that schema
 * Telemetry        ??? long-format rows (time, point_key, value_num, value_text)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createUser, findUser, loadUsers, saveUsers } = require('./auth');
const dataConnectors = require('./data-connectors');
const { safeName } = require('./db-provisioner');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'setup_wizard.json');
const PLATFORM_SCHEMA = 'factory_mios_platform';

const STANDARD_QUERIES = {
  oee_shift: {
    name: 'OEE by shift',
    description: 'Availability ?? Performance ?? Quality for current shift window.',
    sql: `SELECT
  time_bucket('5 minutes', time) AS bucket,
  AVG(CASE WHEN point_key = 'availability_pct' THEN value_num END) AS availability_pct,
  AVG(CASE WHEN point_key = 'performance_pct' THEN value_num END) AS performance_pct,
  AVG(CASE WHEN point_key = 'quality_pct' THEN value_num END) AS quality_pct,
  (
    COALESCE(AVG(CASE WHEN point_key = 'availability_pct' THEN value_num END), 0) *
    COALESCE(AVG(CASE WHEN point_key = 'performance_pct' THEN value_num END), 0) *
    COALESCE(AVG(CASE WHEN point_key = 'quality_pct' THEN value_num END), 0) / 10000
  ) AS oee_pct
FROM "{{schema}}"."{{machine_table}}"
WHERE time >= NOW() - INTERVAL '12 hours'
  AND point_key IN ('availability_pct','performance_pct','quality_pct')
GROUP BY 1
ORDER BY 1 DESC
LIMIT 200`,
  },
  parts_counter_delta: {
    name: 'Parts produced (counter delta)',
    description: 'Shift parts from counter tag using max-min.',
    sql: `SELECT
  MAX(CASE WHEN point_key = 'parts_count' THEN value_num END) -
  MIN(CASE WHEN point_key = 'parts_count' THEN value_num END) AS parts_produced
FROM "{{schema}}"."{{machine_table}}"
WHERE time >= NOW() - INTERVAL '12 hours'`,
  },
  latest_points: {
    name: 'Latest tag values',
    description: 'Most recent value per data point.',
    sql: `SELECT DISTINCT ON (point_key)
  point_key, time, value_num, value_text, unit
FROM "{{schema}}"."{{machine_table}}"
ORDER BY point_key, time DESC`,
  },
};

const DEFAULT_STATE = {
  version: 1,
  completed: false,
  frozen: false,
  frozen_at: null,
  frozen_by: null,
  ingest_api_key: null,
  superadmin: null,
  plants: [],
  data_sources: [],
  metric_relations: [],
  dashboards: [],
  standard_queries: STANDARD_QUERIES,
};

function ensureConfigDir() {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
  try { fs.chmodSync(dir, 0o777); } catch { /* windows bind mounts */ }
}

function saveStateSafe(state) {
  ensureConfigDir();
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(state, null, 2), { mode: 0o666 });
  } catch (err) {
    if (err.code === 'EACCES') {
      throw new Error(
        'Cannot write setup config. Run: docker compose exec -u root app chmod -R 777 /app/config && docker compose restart app'
      );
    }
    throw err;
  }
}

function loadState() {
  ensureConfigDir();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_STATE, ...raw, standard_queries: { ...STANDARD_QUERIES, ...(raw.standard_queries || {}) } };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(state) {
  saveStateSafe(state);
}

function isSetupComplete() {
  const s = loadState();
  return Boolean(s.completed && s.frozen);
}

function isPublicPath(p) {
  const publicPaths = [
    '/welcome', '/setup/connectors', '/setup/data', '/setup/dashboard',
    '/health', '/login',
    '/_shared.css', '/_shared.js',
    '/assets/', '/favicon.ico',
  ];
  if (p.startsWith('/api/setup')) return true;
  if (p.startsWith('/api/ingest/')) return true;
  if (publicPaths.some(x => p === x || p.startsWith(x))) return true;
  return /\.(css|js|png|jpg|svg|ico|woff2?)$/i.test(p);
}

function schemaForPlant(plantId) {
  return safeName(String(plantId || 'plant')).slice(0, 63);
}

function tableForMachine(machineId) {
  return safeName(String(machineId || 'machine')).slice(0, 63);
}

function getDataFormatDoc() {
  return {
    summary: 'Plant = PostgreSQL schema, Machine = table, Points = rows with point_key',
    plant: {
      plant_id: 'unique slug (becomes schema name)',
      plant_name: 'display name',
      schema: 'postgresql schema = safeName(plant_id)',
    },
    machine: {
      machine_id: 'unique slug (becomes table name)',
      machine_name: 'display name',
      table: 'table under plant schema = safeName(machine_id)',
    },
    telemetry_row: {
      time: 'ISO-8601 timestamp (UTC recommended)',
      point_key: 'tag id e.g. parts_count, kwh_total',
      value_num: 'numeric value (optional)',
      value_text: 'text/boolean/status (optional)',
      unit: 'optional unit string',
      meta: 'optional JSON object',
    },
    mqtt_https_ingest: {
      method: 'POST',
      url: '/api/ingest/v1/{plant_id}/{machine_id}',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Key': '<from setup wizard>' },
      body: {
        time: '2026-06-04T10:00:00Z',
        points: { parts_count: 120, is_running: 1, machine_state: 'running' },
      },
    },
    example_plant_machine: {
      plant_id: 'acme_plant_1',
      schema: 'acme_plant_1',
      machine_id: 'line_01',
      table: 'line_01',
    },
  };
}

async function ensurePlatformMeta(pool) {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${PLATFORM_SCHEMA}"`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${PLATFORM_SCHEMA}"."setup_audit" (
      id SERIAL PRIMARY KEY,
      action VARCHAR(64),
      detail JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function testDatabase(pool) {
  const r = await pool.query('SELECT NOW() AS now, current_database() AS db');
  let timescale = false;
  try {
    const ts = await pool.query(`SELECT extversion FROM pg_extension WHERE extname = 'timescaledb' LIMIT 1`);
    timescale = ts.rows.length > 0;
  } catch { /* ignore */ }
  return {
    ok: true,
    status: 'connected',
    database: r.rows[0]?.db,
    server_time: r.rows[0]?.now,
    timescaledb: timescale,
  };
}

async function provisionPlant(pool, plant) {
  const schema = schemaForPlant(plant.plant_id);
  await ensurePlatformMeta(pool);
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${schema}"."_plant_meta" (
      plant_id VARCHAR(64) PRIMARY KEY,
      plant_name VARCHAR(256),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(
    `INSERT INTO "${schema}"."_plant_meta" (plant_id, plant_name)
     VALUES ($1,$2)
     ON CONFLICT (plant_id) DO UPDATE SET plant_name = EXCLUDED.plant_name, updated_at = NOW()`,
    [plant.plant_id, plant.plant_name || plant.plant_id]
  );
  return { schema, plant_id: plant.plant_id };
}

async function provisionMachine(pool, plantId, machine) {
  const schema = schemaForPlant(plantId);
  const table = tableForMachine(machine.machine_id);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${schema}"."${table}" (
      time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      point_key VARCHAR(128) NOT NULL,
      value_num NUMERIC,
      value_text TEXT,
      unit VARCHAR(32),
      meta JSONB DEFAULT '{}'::jsonb
    )
  `);
  try {
    await pool.query(`
      SELECT create_hypertable('${schema}.${table}', 'time', if_not_exists => TRUE, migrate_data => TRUE)
    `);
  } catch { /* non-timescale */ }
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_${table}_pt ON "${schema}"."${table}" (point_key, time DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${schema}"."_machines" (
      machine_id VARCHAR(64) PRIMARY KEY,
      machine_name VARCHAR(256),
      table_name VARCHAR(64),
      tags JSONB DEFAULT '[]'::jsonb,
      poll_interval_sec INT DEFAULT 30,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(
    `INSERT INTO "${schema}"."_machines" (machine_id, machine_name, table_name, tags, poll_interval_sec)
     VALUES ($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT (machine_id) DO UPDATE SET
       machine_name = EXCLUDED.machine_name,
       table_name = EXCLUDED.table_name,
       tags = EXCLUDED.tags,
       poll_interval_sec = EXCLUDED.poll_interval_sec`,
    [
      machine.machine_id,
      machine.machine_name || machine.machine_id,
      table,
      JSON.stringify(machine.tags || []),
      parseInt(machine.poll_interval_sec || '30', 10),
    ]
  );
  return { schema, table, machine_id: machine.machine_id };
}

async function insertPoints(pool, plantId, machineId, points, timeIso) {
  const schema = schemaForPlant(plantId);
  const table = tableForMachine(machineId);
  const ts = timeIso ? new Date(timeIso) : new Date();
  if (Number.isNaN(ts.getTime())) throw new Error('Invalid time');

  const entries = typeof points === 'object' && points ? Object.entries(points) : [];
  if (!entries.length) throw new Error('No points in payload');

  for (const [key, val] of entries) {
    const pointKey = safeName(key).replace(/_/g, '_') || 'value';
    let valueNum = null;
    let valueText = null;
    if (typeof val === 'number') valueNum = val;
    else if (typeof val === 'boolean') valueText = val ? 'true' : 'false';
    else if (val !== null && val !== undefined) {
      const n = Number(val);
      valueNum = Number.isFinite(n) ? n : null;
      valueText = valueNum === null ? String(val) : null;
    }
    await pool.query(
      `INSERT INTO "${schema}"."${table}" (time, point_key, value_num, value_text)
       VALUES ($1,$2,$3,$4)`,
      [ts, pointKey, valueNum, valueText]
    );
  }
  return { inserted: entries.length, schema, table };
}

async function fetchMachineData(pool, plantId, machineId, limit = 100) {
  const schema = schemaForPlant(plantId);
  const table = tableForMachine(machineId);
  const r = await pool.query(
    `SELECT time, point_key, value_num, value_text, unit
     FROM "${schema}"."${table}"
     ORDER BY time DESC
     LIMIT $1`,
    [Math.min(parseInt(limit, 10) || 100, 500)]
  );
  return r.rows;
}

function validateFormula(formula) {
  const f = String(formula || '').trim();
  if (!f) throw new Error('Formula is required');
  if (!/^[a-z0-9_+\-*/().\s%]+$/i.test(f)) {
    throw new Error('Formula may only use letters, numbers, underscore, + - * / ( ) and spaces');
  }
  return f;
}

function evaluateFormula(formula, scope) {
  const safe = validateFormula(formula);
  const keys = Object.keys(scope || {});
  const vals = keys.map(k => Number(scope[k]) || 0);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...keys, `return (${safe});`);
  return fn(...vals);
}

function renderQuery(template, schema, machineTable) {
  return String(template || '')
    .replace(/\{\{schema\}\}/g, schema)
    .replace(/\{\{machine_table\}\}/g, machineTable);
}

async function runStandardQuery(pool, plantId, machineId, queryKey) {
  const q = STANDARD_QUERIES[queryKey];
  if (!q) throw new Error('Unknown query key');
  const sql = renderQuery(q.sql, schemaForPlant(plantId), tableForMachine(machineId));
  if (!/^select\s/i.test(sql.trim())) throw new Error('Only SELECT queries allowed');
  const r = await pool.query(sql);
  return { rows: r.rows, sql };
}

async function syncSourceToMachine(pool, sourceConfig, plantId, machineId, fieldMap) {
  const preview = await dataConnectors.previewSource(sourceConfig, { user: { role: 'superadmin', tenant_id: null } });
  const rows = Array.isArray(preview) ? preview : [];
  let inserted = 0;
  for (const row of rows.slice(0, 500)) {
    const points = {};
    for (const [src, dst] of Object.entries(fieldMap || {})) {
      if (row[src] !== undefined) points[dst || src] = row[src];
    }
    if (!Object.keys(points).length) {
      Object.keys(row).forEach(k => { if (k !== 'time' && k !== 'timestamp') points[k] = row[k]; });
    }
    const t = row.time || row.timestamp || row.ts;
    await insertPoints(pool, plantId, machineId, points, t);
    inserted++;
  }
  return { inserted, preview_count: rows.length };
}

function clearBootstrapUsers() {
  const store = loadUsers();
  const filtered = store.users.filter(u => {
    if (u.role === 'superadmin') return false;
    if (u.username === 'admin' && u.role === 'admin') return false;
    return true;
  });
  if (filtered.length !== store.users.length) {
    store.users = filtered;
    saveUsers(store);
  }
}

function resetSetupAuth() {
  const state = loadState();
  if (state.frozen) throw new Error('Setup is frozen. Unfreeze before resetting auth.');
  clearBootstrapUsers();
  state.superadmin = null;
  saveState(state);
  return { ok: true, message: 'Bootstrap users removed. You can create a new super admin.' };
}

async function createSuperAdmin({ username, password, name, email }) {
  const u = String(username || '').toLowerCase().trim();
  if (!u || !password) throw new Error('Username and password required');

  const state = loadState();
  if (state.frozen) throw new Error('Setup is frozen. Unfreeze to change super admin.');

  clearBootstrapUsers();
  const store = loadUsers();
  const idx = store.users.findIndex(x => x.username === u);
  if (idx >= 0) store.users.splice(idx, 1);
  saveUsers(store);
  state.superadmin = null;
  saveState(state);

  const user = await createUser({
    username: u,
    password,
    name: name || 'Platform Super Admin',
    role: 'superadmin',
    email: email || `${u}@factory-mios.local`,
    plant_ids: [],
    tenant_id: null,
  });
  state.superadmin = { username: user.username, created_at: new Date().toISOString() };
  if (!state.ingest_api_key) state.ingest_api_key = crypto.randomBytes(24).toString('hex');
  saveState(state);
  return { user: { username: user.username, role: user.role }, ingest_api_key: state.ingest_api_key };
}

function assertNotFrozen() {
  const s = loadState();
  if (s.frozen) throw new Error('Setup is frozen. Superadmin must unfreeze to edit.');
  return s;
}

function assertSuperadmin(user) {
  if (!user || user.role !== 'superadmin') throw new Error('Superadmin role required');
}

async function freezeSetup(user) {
  assertSuperadmin(user);
  const s = loadState();
  if (!s.superadmin) throw new Error('Create superadmin first');
  if (!s.plants.length) throw new Error('Add at least one plant');
  const hasMachine = s.plants.some(p => (p.machines || []).length > 0);
  if (!hasMachine) throw new Error('Add at least one machine/device');
  s.completed = true;
  s.frozen = true;
  s.frozen_at = new Date().toISOString();
  s.frozen_by = user.username;
  saveState(s);
  return s;
}

function unfreezeSetup(user) {
  assertSuperadmin(user);
  const s = loadState();
  s.frozen = false;
  s.completed = false;
  saveState(s);
  return s;
}

function upsertPlant(plant) {
  const s = loadState();
  if (!plant.plant_id) throw new Error('plant_id required');
  const idx = s.plants.findIndex(p => p.plant_id === plant.plant_id);
  const entry = {
    plant_id: plant.plant_id,
    plant_name: plant.plant_name || plant.plant_id,
    machines: plant.machines || (idx >= 0 ? s.plants[idx].machines : []),
    data_sources: plant.data_sources || (idx >= 0 ? s.plants[idx].data_sources : []),
  };
  if (idx >= 0) s.plants[idx] = { ...s.plants[idx], ...entry };
  else s.plants.push(entry);
  saveState(s);
  return entry;
}

function upsertMachine(plantId, machine) {
  const s = loadState();
  const plant = s.plants.find(p => p.plant_id === plantId);
  if (!plant) throw new Error('Plant not found');
  if (!machine.machine_id) throw new Error('machine_id required');
  const idx = (plant.machines || []).findIndex(m => m.machine_id === machine.machine_id);
  const entry = {
    machine_id: machine.machine_id,
    machine_name: machine.machine_name || machine.machine_id,
    tags: machine.tags || [],
    poll_interval_sec: machine.poll_interval_sec || 30,
    connectivity: machine.connectivity || { status: 'pending' },
  };
  if (!plant.machines) plant.machines = [];
  if (idx >= 0) plant.machines[idx] = { ...plant.machines[idx], ...entry };
  else plant.machines.push(entry);
  saveState(s);
  return entry;
}

function addDataSource(plantId, source) {
  const s = loadState();
  const plant = s.plants.find(p => p.plant_id === plantId);
  if (!plant) throw new Error('Plant not found');
  if (!plant.data_sources) plant.data_sources = [];
  const id = source.id || `src_${Date.now()}`;
  const entry = { ...source, id, plant_id: plantId, status: source.status || 'pending' };
  const idx = plant.data_sources.findIndex(x => x.id === id);
  if (idx >= 0) plant.data_sources[idx] = entry;
  else plant.data_sources.push(entry);
  saveState(s);
  return entry;
}

function addMetricRelation(rel) {
  const s = loadState();
  validateFormula(rel.formula);
  s.metric_relations.push({
    id: rel.id || `rel_${Date.now()}`,
    plant_id: rel.plant_id,
    machine_id: rel.machine_id,
    name: rel.name,
    formula: rel.formula,
    inputs: rel.inputs || [],
    created_at: new Date().toISOString(),
  });
  saveState(s);
  return s.metric_relations[s.metric_relations.length - 1];
}

function addDashboard(dash) {
  const s = loadState();
  s.dashboards.push({
    id: dash.id || `dash_${Date.now()}`,
    name: dash.name || 'Dashboard',
    widgets: dash.widgets || [],
    plant_id: dash.plant_id,
    created_at: new Date().toISOString(),
  });
  saveState(s);
  return s.dashboards[s.dashboards.length - 1];
}

function verifyIngestKey(key) {
  const s = loadState();
  return s.ingest_api_key && key === s.ingest_api_key;
}

async function importTelemetryRows(pool, plantId, machineId, rows) {
  let inserted = 0;
  for (const row of rows || []) {
    const pk = String(row.point_key || '').trim();
    if (!pk) continue;
    const points = {};
    if (row.value_num != null && row.value_num !== '') points[pk] = row.value_num;
    else if (row.value_text != null && row.value_text !== '') points[pk] = row.value_text;
    else continue;
    await insertPoints(pool, plantId, machineId, points, row.time);
    inserted++;
  }
  return { inserted, schema: schemaForPlant(plantId), table: tableForMachine(machineId) };
}

function getPublicStatus() {
  const s = loadState();
  return {
    completed: s.completed,
    frozen: s.frozen,
    has_superadmin: Boolean(s.superadmin),
    plants: s.plants.map(p => ({
      plant_id: p.plant_id,
      plant_name: p.plant_name,
      schema: schemaForPlant(p.plant_id),
      machines: (p.machines || []).map(m => ({
        machine_id: m.machine_id,
        machine_name: m.machine_name,
        table: tableForMachine(m.machine_id),
        connectivity: m.connectivity || {},
        tags: m.tags || [],
      })),
      data_sources: (p.data_sources || []).map(ds => ({
        id: ds.id, type: ds.type, name: ds.name, status: ds.status,
      })),
    })),
    metric_relations_count: s.metric_relations.length,
    dashboards_count: s.dashboards.length,
    ingest_url_pattern: '/api/ingest/v1/{plant_id}/{machine_id}',
    has_ingest_key: Boolean(s.ingest_api_key),
  };
}

module.exports = {
  CONFIG_PATH,
  PLATFORM_SCHEMA,
  STANDARD_QUERIES,
  loadState,
  saveState,
  isSetupComplete,
  isPublicPath,
  getDataFormatDoc,
  schemaForPlant,
  tableForMachine,
  testDatabase,
  provisionPlant,
  provisionMachine,
  insertPoints,
  fetchMachineData,
  validateFormula,
  evaluateFormula,
  renderQuery,
  runStandardQuery,
  syncSourceToMachine,
  importTelemetryRows,
  clearBootstrapUsers,
  resetSetupAuth,
  createSuperAdmin,
  freezeSetup,
  unfreezeSetup,
  upsertPlant,
  upsertMachine,
  addDataSource,
  addMetricRelation,
  addDashboard,
  verifyIngestKey,
  getPublicStatus,
  assertNotFrozen,
  assertSuperadmin,
};

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const ExcelJS = require('exceljs');
const { Pool } = require('pg');
const mqtt = require('mqtt');

const ROOT_DIR = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'config', 'data_sources.json');
const IMPORT_DIR = path.resolve(process.env.DATA_IMPORT_DIR || path.join(ROOT_DIR, 'imports'));
const MAX_PREVIEW_ROWS = parseInt(process.env.DATA_SOURCE_PREVIEW_ROWS || '100', 10);
const DEFAULT_CACHE_TTL_MS = parseInt(process.env.DATA_SOURCE_CACHE_TTL_MS || '30000', 10);
const SQL_TIMEOUT_MS = parseInt(process.env.DATA_SOURCE_SQL_TIMEOUT_MS || '10000', 10);
const MQTT_SAMPLE_TIMEOUT_MS = parseInt(process.env.DATA_SOURCE_MQTT_TIMEOUT_MS || '10000', 10);
const SECRET_FIELDS = ['connectionString', 'password', 'token'];
const cache = new Map();

const SOURCE_TYPES = [
  { type: 'json_url', label: 'JSON URL / HTTP API', description: 'Fetch rows from an HTTP/HTTPS endpoint that returns JSON.', required: ['url'] },
  { type: 'json_file', label: 'JSON file', description: `Read JSON from a file under ${IMPORT_DIR}.`, required: ['file'] },
  { type: 'excel_file', label: 'Excel / CSV file', description: `Read .xlsx, .xls, or .csv files from ${IMPORT_DIR}.`, required: ['file'] },
  { type: 'postgres', label: 'External PostgreSQL / TimescaleDB SQL', description: 'Run a read-only SELECT query against another PostgreSQL-compatible database.', required: ['connectionString', 'query'] },
  { type: 'mqtt', label: 'MQTT topic sample', description: 'Connect to an MQTT broker and wait for one JSON message from a topic.', required: ['brokerUrl', 'topic'] },
];

function ensureDirs() {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.mkdirSync(IMPORT_DIR, { recursive: true });
}

function encryptionKey() {
  const secret = process.env.DATA_CONNECTOR_SECRET || process.env.JWT_SECRET || 'factory-mios-dev-connector-secret';
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encryptValue(value) {
  if (value === undefined || value === null || value === '') return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptValue(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:v1:')) return value;
  const [, , ivB64, tagB64, dataB64] = value.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

function encryptHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => {
    return /authorization|token|key|secret|password/i.test(k) ? [k, encryptValue(v)] : [k, v];
  }));
}

function decryptHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, decryptValue(v)]));
}

function encryptSource(source) {
  const out = { ...source };
  for (const field of SECRET_FIELDS) if (out[field]) out[field] = encryptValue(out[field]);
  if (out.headers) out.headers = encryptHeaders(out.headers);
  return out;
}

function decryptSource(source) {
  if (!source) return source;
  const out = { ...source };
  for (const field of SECRET_FIELDS) if (out[field]) out[field] = decryptValue(out[field]);
  if (out.headers) out.headers = decryptHeaders(out.headers);
  return out;
}

function loadStore() {
  ensureDirs();
  try {
    const store = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { sources: Array.isArray(store.sources) ? store.sources : [] };
  } catch {
    return { sources: [] };
  }
}

function saveStore(store) {
  ensureDirs();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(store, null, 2));
}

function safeId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function tenantIdFromUser(user) {
  if (!user) return 'anonymous';
  if (user.role === 'superadmin') return user.tenant_id ? String(user.tenant_id) : 'platform';
  return user.tenant_id ? String(user.tenant_id) : 'default';
}

function canSeeSource(source, user) {
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  return String(source.tenant_id || 'default') === tenantIdFromUser(user);
}

function maskConnectionString(connectionString) {
  try {
    const u = new URL(connectionString);
    if (u.password) u.password = '********';
    return u.toString();
  } catch {
    return '********';
  }
}

function sanitizeSource(source) {
  const copy = { ...decryptSource(source) };
  if (copy.connectionString) copy.connectionString = maskConnectionString(copy.connectionString);
  if (copy.password) copy.password = '********';
  if (copy.token) copy.token = '********';
  if (copy.headers) {
    copy.headers = Object.fromEntries(Object.entries(copy.headers).map(([k, v]) => {
      return /authorization|token|key|secret|password/i.test(k) ? [k, '********'] : [k, v];
    }));
  }
  copy.encrypted = true;
  return copy;
}

function listSources(user) {
  return loadStore().sources.filter(s => !user || canSeeSource(s, user)).map(sanitizeSource);
}

function getSource(id, { includeSecrets = false, user = null } = {}) {
  const raw = loadStore().sources.find(s => s.id === id);
  if (!raw || (user && !canSeeSource(raw, user))) return null;
  const source = includeSecrets ? decryptSource(raw) : sanitizeSource(raw);
  return source;
}

function upsertSource(input, { user = null } = {}) {
  const store = loadStore();
  const type = String(input.type || '').trim();
  if (!SOURCE_TYPES.some(t => t.type === type)) throw new Error(`Unsupported source type: ${type}`);

  const id = safeId(input.id || input.name || `${type}-${Date.now()}`);
  if (!id) throw new Error('Source id or name is required');
  const existing = store.sources.find(s => s.id === id);
  if (existing && user && !canSeeSource(existing, user)) throw new Error('Not allowed to update this source');

  const now = new Date().toISOString();
  const tenant_id = user?.role === 'superadmin' && input.tenant_id !== undefined ? String(input.tenant_id || 'platform') : tenantIdFromUser(user);
  const source = encryptSource({
    ...input,
    id,
    type,
    tenant_id,
    name: input.name || id,
    enabled: input.enabled !== false,
    cache_ttl_ms: parseInt(input.cache_ttl_ms || DEFAULT_CACHE_TTL_MS, 10),
    updated_at: now,
  });

  const idx = store.sources.findIndex(s => s.id === id);
  if (idx >= 0) {
    source.created_at = store.sources[idx].created_at || now;
    store.sources[idx] = { ...store.sources[idx], ...source };
  } else {
    source.created_at = now;
    store.sources.push(source);
  }
  saveStore(store);
  cache.delete(id);
  return sanitizeSource(source);
}

function removeSource(id, { user = null } = {}) {
  const store = loadStore();
  const source = store.sources.find(s => s.id === id);
  if (!source) return false;
  if (user && !canSeeSource(source, user)) throw new Error('Not allowed to delete this source');
  store.sources = store.sources.filter(s => s.id !== id);
  saveStore(store);
  cache.delete(id);
  return true;
}

function normalizeRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [{ value: payload }];
  for (const key of ['rows', 'data', 'items', 'readings', 'records', 'result']) if (Array.isArray(payload[key])) return payload[key];
  return [payload];
}

function limitRows(rows, limit = MAX_PREVIEW_ROWS) {
  return rows.slice(0, Math.max(1, parseInt(limit || MAX_PREVIEW_ROWS, 10)));
}

function fieldMetadata(rows) {
  const fields = new Map();
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;
    for (const [key, value] of Object.entries(row)) {
      const meta = fields.get(key) || { name: key, type: 'empty', samples: [] };
      if (value !== null && value !== undefined && meta.samples.length < 3) meta.samples.push(value);
      const valueType = value instanceof Date ? 'date' : typeof value;
      if (meta.type === 'empty' && value !== null && value !== undefined) meta.type = valueType;
      else if (value !== null && value !== undefined && meta.type !== valueType) meta.type = 'mixed';
      fields.set(key, meta);
    }
  }
  return Array.from(fields.values());
}

function mapRows(rows, mapping = {}) {
  const valueField = mapping.valueField || mapping.yField || mapping.metricField;
  const labelField = mapping.labelField || mapping.xField || mapping.nameField;
  const timeField = mapping.timeField || mapping.timestampField;
  if (!valueField && !labelField && !timeField) return rows;
  return rows.map(row => ({
    label: labelField ? row?.[labelField] : undefined,
    value: valueField ? row?.[valueField] : undefined,
    time: timeField ? row?.[timeField] : undefined,
    raw: row,
  }));
}

function resolveImportFile(file) {
  if (!file) throw new Error('file is required');
  const resolved = path.resolve(IMPORT_DIR, file);
  const rel = path.relative(IMPORT_DIR, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('File must be inside DATA_IMPORT_DIR/imports');
  return resolved;
}

async function previewJsonUrl(source) {
  if (!/^https?:\/\//i.test(source.url || '')) throw new Error('url must start with http:// or https://');
  const headers = source.headers && typeof source.headers === 'object' ? source.headers : {};
  const res = await fetch(source.url, { headers, timeout: parseInt(source.timeoutMs || '10000', 10) });
  if (!res.ok) throw new Error(`JSON URL returned HTTP ${res.status}`);
  const payload = await res.json();
  return limitRows(normalizeRows(payload), source.limit || MAX_PREVIEW_ROWS);
}

async function previewJsonFile(source) {
  const filePath = resolveImportFile(source.file);
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return limitRows(normalizeRows(payload), source.limit || MAX_PREVIEW_ROWS);
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = splitCsvLine(line);
    return Object.fromEntries(headers.map((h, i) => [h || `col_${i + 1}`, values[i] ?? '']));
  });
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

async function previewExcelFile(source) {
  const filePath = resolveImportFile(source.file);
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv') return limitRows(parseCsv(fs.readFileSync(filePath, 'utf8')), source.limit || MAX_PREVIEW_ROWS);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = source.sheet ? workbook.getWorksheet(source.sheet) : workbook.worksheets[0];
  if (!sheet) throw new Error('Worksheet not found');
  const headerRow = sheet.getRow(parseInt(source.headerRow || '1', 10));
  const headers = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => headers[col] = String(cell.value || `col_${col}`).trim());
  const rows = [];
  sheet.eachRow((row, rowNo) => {
    if (rowNo <= headerRow.number) return;
    const obj = {};
    row.eachCell({ includeEmpty: true }, (cell, col) => { obj[headers[col] || `col_${col}`] = cell.value; });
    rows.push(obj);
  });
  return limitRows(rows, source.limit || MAX_PREVIEW_ROWS);
}

function validateReadOnlySql(query) {
  const sql = String(query || '').trim();
  if (!sql) throw new Error('query is required');
  if (!/^select\b/i.test(sql)) throw new Error('Only SELECT queries are allowed for external SQL sources');
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do)\b/i.test(sql)) throw new Error('Unsafe SQL keyword found');
  return sql.replace(/;\s*$/, '');
}

async function previewPostgres(source) {
  const query = validateReadOnlySql(source.query);
  const pool = new Pool({
    connectionString: source.connectionString,
    host: source.host,
    port: source.port ? parseInt(source.port, 10) : undefined,
    database: source.database,
    user: source.user,
    password: source.password,
    max: 1,
    connectionTimeoutMillis: SQL_TIMEOUT_MS,
    idleTimeoutMillis: 1000,
  });
  try {
    const limitedQuery = `SELECT * FROM (${query}) AS external_source_preview LIMIT $1`;
    const r = await pool.query(limitedQuery, [parseInt(source.limit || MAX_PREVIEW_ROWS, 10)]);
    return r.rows;
  } finally {
    await pool.end().catch(() => {});
  }
}

async function previewMqtt(source) {
  if (!source.brokerUrl) throw new Error('brokerUrl is required');
  if (!source.topic) throw new Error('topic is required');
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(source.brokerUrl, {
      username: source.username || undefined,
      password: source.password || undefined,
      clientId: source.clientId || `factory-mios-preview-${Date.now()}`,
      connectTimeout: MQTT_SAMPLE_TIMEOUT_MS,
      reconnectPeriod: 0,
    });
    const timer = setTimeout(() => {
      client.end(true);
      reject(new Error(`No MQTT message received on ${source.topic} within ${MQTT_SAMPLE_TIMEOUT_MS}ms`));
    }, MQTT_SAMPLE_TIMEOUT_MS);
    client.on('connect', () => client.subscribe(source.topic, err => {
      if (err) { clearTimeout(timer); client.end(true); reject(err); }
    }));
    client.on('message', (_topic, message) => {
      clearTimeout(timer);
      client.end(true);
      const text = message.toString('utf8');
      try { resolve(limitRows(normalizeRows(JSON.parse(text)), source.limit || MAX_PREVIEW_ROWS)); }
      catch { resolve([{ topic: source.topic, payload: text }]); }
    });
    client.on('error', err => { clearTimeout(timer); client.end(true); reject(err); });
  });
}

async function uncachedPreview(source) {
  if (!source) throw new Error('Source not found');
  switch (source.type) {
    case 'json_url': return previewJsonUrl(source);
    case 'json_file': return previewJsonFile(source);
    case 'excel_file': return previewExcelFile(source);
    case 'postgres': return previewPostgres(source);
    case 'mqtt': return previewMqtt(source);
    default: throw new Error(`Unsupported source type: ${source.type}`);
  }
}

async function previewSource(sourceOrId, options = {}) {
  const source = typeof sourceOrId === 'string' ? getSource(sourceOrId, { includeSecrets: true, user: options.user }) : sourceOrId;
  return uncachedPreview(source);
}

async function readSourceData(id, { user = null, refresh = false, limit = MAX_PREVIEW_ROWS, mapping = {} } = {}) {
  const source = getSource(id, { includeSecrets: true, user });
  if (!source) throw new Error('Source not found');
  const ttl = parseInt(source.cache_ttl_ms || DEFAULT_CACHE_TTL_MS, 10);
  const cacheKey = `${tenantIdFromUser(user)}:${id}:${limit}`;
  const hit = cache.get(cacheKey);
  const now = Date.now();
  if (!refresh && hit && now - hit.createdAt < ttl) {
    return { ...hit.payload, cached: true, cache_age_ms: now - hit.createdAt };
  }
  const rows = limitRows(await uncachedPreview({ ...source, limit }), limit);
  const payload = {
    source: sanitizeSource(source),
    rows,
    mapped: mapRows(rows, mapping),
    fields: fieldMetadata(rows),
    count: rows.length,
    cached: false,
    cache_ttl_ms: ttl,
    fetched_at: new Date().toISOString(),
  };
  cache.set(cacheKey, { createdAt: now, payload });
  return payload;
}

function clearCache(id) {
  for (const key of Array.from(cache.keys())) if (!id || key.includes(`:${id}:`)) cache.delete(key);
}

function importDirectory() {
  ensureDirs();
  return IMPORT_DIR;
}

module.exports = {
  SOURCE_TYPES,
  importDirectory,
  listSources,
  getSource,
  upsertSource,
  removeSource,
  previewSource,
  readSourceData,
  clearCache,
  sanitizeSource,
  validateReadOnlySql,
  fieldMetadata,
};

'use strict';

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const mqtt = require('mqtt');
const ExcelJS = require('exceljs');
const crypto = require('crypto');

const IMPORT_DIR = path.resolve(process.env.DATA_IMPORT_DIR || path.join(__dirname, '..', 'imports'));
const MQTT_TIMEOUT_MS = parseInt(process.env.DATA_SOURCE_MQTT_TIMEOUT_MS || '15000', 10);

/** Required columns for long-format import (see DATA_IMPORT_FORMAT.md) */
const REQUIRED_LONG_COLUMNS = ['time', 'point_key'];
const OPTIONAL_LONG_COLUMNS = ['value_num', 'value_text', 'unit'];

const EXCEL_FORMAT = {
  description: 'Factory-MIOS machine telemetry import format',
  long_format_columns: ['time', 'point_key', 'value_num', 'value_text', 'unit'],
  wide_format: 'First column must be time (or timestamp). Other columns = point_key names.',
  example_long: [
    { time: '2026-06-04T10:00:00Z', point_key: 'parts_count', value_num: 120, value_text: '', unit: 'parts' },
    { time: '2026-06-04T10:00:00Z', point_key: 'is_running', value_num: 1, value_text: '', unit: '' },
  ],
  example_wide: [
    { time: '2026-06-04T10:00:00Z', parts_count: 120, is_running: 1, kwh_total: 99.5 },
  ],
};

function ensureImportDir() {
  fs.mkdirSync(IMPORT_DIR, { recursive: true });
}

function sanitizePointKey(key) {
  return String(key || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 128) || 'value';
}

function parseCsvText(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const split = (line) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { quoted = !quoted; continue; }
      if (ch === ',' && !quoted) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const headers = split(lines[0]).map((h, i) => h || `col_${i + 1}`);
  const rows = lines.slice(1).map(line => {
    const vals = split(line);
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']));
  });
  return { headers, rows };
}

async function parseUploadBuffer(buffer, filename, headerRow = 1) {
  ensureImportDir();
  const ext = path.extname(filename || '').toLowerCase();
  const rawRows = [];

  if (ext === '.csv') {
    const parsed = parseCsvText(buffer.toString('utf8'));
    return { headers: parsed.headers, rows: parsed.rows, format: 'csv' };
  }

  if (ext === '.xlsx' || ext === '.xls') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error('No worksheet in Excel file');
    const hr = parseInt(headerRow, 10) || 1;
    const headerCells = sheet.getRow(hr);
    const headers = [];
    headerCells.eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col] = String(cell.value ?? `col_${col}`).trim();
    });
    sheet.eachRow((row, rowNo) => {
      if (rowNo <= hr) return;
      const obj = {};
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        obj[headers[col] || `col_${col}`] = cell.value;
      });
      rawRows.push(obj);
    });
    return { headers: headers.filter(Boolean), rows: rawRows, format: 'xlsx' };
  }

  throw new Error('Supported uploads: .csv, .xlsx');
}

function detectFormat(headers, rows) {
  const lower = headers.map(h => sanitizePointKey(h));
  const hasLong = lower.includes('time') && (lower.includes('point_key') || lower.includes('point'));
  if (hasLong) return 'long';
  const timeCol = headers.find(h => /^(time|timestamp|ts|datetime)$/i.test(String(h).trim()));
  if (timeCol) return 'wide';
  if (rows[0] && (rows[0].time || rows[0].timestamp)) return 'wide';
  return 'unknown';
}

function normalizeRows(rawRows, columnMap = {}, formatHint) {
  const fmt = formatHint || 'auto';
  const out = [];

  for (const row of rawRows) {
    const mapped = {};
    for (const [src, dst] of Object.entries(columnMap)) {
      if (row[src] !== undefined) mapped[dst || sanitizePointKey(src)] = row[src];
    }
    const base = Object.keys(columnMap).length ? mapped : row;

    const timeKeys = ['time', 'timestamp', 'ts', 'datetime'];
    const timeVal = timeKeys.map(k => base[k]).find(v => v != null && v !== '');
    const timeIso = timeVal instanceof Date ? timeVal.toISOString() : new Date(timeVal || Date.now()).toISOString();

    const pointKey = base.point_key || base.point || base.tag;
    if (pointKey && (fmt === 'long' || fmt === 'auto')) {
      out.push({
        time: timeIso,
        point_key: sanitizePointKey(columnMap.point_key ? base[columnMap.point_key] : pointKey),
        value_num: numOrNull(base.value_num ?? base.value),
        value_text: base.value_text != null ? String(base.value_text) : null,
        unit: base.unit ? String(base.unit) : null,
      });
      continue;
    }

    // Wide format: one row per timestamp, explode columns to point_key rows
    for (const [k, v] of Object.entries(base)) {
      if (timeKeys.includes(k.toLowerCase()) || timeKeys.includes(sanitizePointKey(k))) continue;
      const pk = columnMap[k] ? sanitizePointKey(columnMap[k]) : sanitizePointKey(k);
      if (!pk) continue;
      const n = Number(v);
      out.push({
        time: timeIso,
        point_key: pk,
        value_num: Number.isFinite(n) ? n : null,
        value_text: Number.isFinite(n) ? null : (v != null ? String(v) : null),
        unit: null,
      });
    }
  }
  return out;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** mqtt.js misparses bare host:port IPs (e.g. 88.99.81.138:1883 → 0.0.7.91:1883) without a scheme */
function normalizeBrokerUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) throw new Error('Broker URL is required');
  if (/^mqtts?:\/\//i.test(url)) return url;
  if (/^wss?:\/\//i.test(url)) {
    throw new Error('Use mqtt:// or mqtts:// for the broker URL (not ws://)');
  }
  const withScheme = `mqtt://${url.replace(/^\/\//, '')}`;
  return withScheme;
}

async function testMqtt(cfg) {
  const brokerUrl = normalizeBrokerUrl(cfg.brokerUrl || cfg.url);
  if (!cfg.topic) throw new Error('Topic is required');

  const qos = parseInt(cfg.qos ?? '0', 10);
  if (![0, 1, 2].includes(qos)) throw new Error('QoS must be 0, 1, or 2');

  const { platformClientId } = require('./mqtt-live-ingest');
  const testClientId = platformClientId({ clientId: cfg.clientId || 'factory-mios-test' });

  return new Promise((resolve, reject) => {
    let connected = false;
    const client = mqtt.connect(brokerUrl, {
      username: cfg.username || undefined,
      password: cfg.password || undefined,
      clientId: testClientId,
      protocolVersion: cfg.protocolVersion ? parseInt(cfg.protocolVersion, 10) : 4,
      clean: cfg.cleanSession !== false,
      reconnectPeriod: 0,
      connectTimeout: MQTT_TIMEOUT_MS,
    });
    const timer = setTimeout(() => {
      client.end(true);
      if (connected) {
        resolve({
          ok: true,
          status: 'connected',
          broker_connected: true,
          message_received: false,
          topic: cfg.topic,
          qos,
          clientId: testClientId,
          note: `Broker connected but no message on "${cfg.topic}" within ${MQTT_TIMEOUT_MS}ms. Live ingest will still work when messages arrive.`,
        });
        return;
      }
      reject(new Error(`Could not connect to broker within ${MQTT_TIMEOUT_MS}ms`));
    }, MQTT_TIMEOUT_MS);

    client.on('connect', () => {
      connected = true;
      client.subscribe(cfg.topic, { qos }, err => {
        if (err) { clearTimeout(timer); client.end(true); reject(err); }
      });
    });
    client.on('message', (topic, message) => {
      clearTimeout(timer);
      client.end(true);
      const text = message.toString('utf8');
      let payload;
      try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
      const points = payload.points || payload;
      resolve({
        ok: true,
        status: 'connected',
        broker_connected: true,
        message_received: true,
        topic,
        qos,
        clientId: testClientId,
        sample: payload,
        points_preview: typeof points === 'object' ? Object.keys(points).slice(0, 20) : [],
      });
    });
    client.on('error', err => { clearTimeout(timer); client.end(true); reject(err); });
  });
}

async function testHttps(cfg) {
  const url = cfg.url;
  if (!url || !/^https?:\/\//i.test(url)) throw new Error('URL must start with http:// or https://');
  const method = (cfg.method || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method)) throw new Error('Method must be GET or POST');

  const headers = { ...(cfg.headers || {}) };
  if (cfg.authHeader) headers.Authorization = cfg.authHeader;
  if (cfg.apiKey && cfg.apiKeyHeader) headers[cfg.apiKeyHeader] = cfg.apiKey;

  const opts = { method, headers, timeout: parseInt(cfg.timeoutMs || '10000', 10) };
  if (method === 'POST' && cfg.body) {
    opts.body = typeof cfg.body === 'string' ? cfg.body : JSON.stringify(cfg.body);
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);

  let payload;
  try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 500) }; }

  return {
    ok: true,
    status: 'connected',
    http_status: res.status,
    method,
    sample: payload,
  };
}

function buildHttpsSourceConfig(cfg) {
  return {
    type: 'https_api',
    name: cfg.name || 'HTTPS API',
    url: cfg.url,
    method: cfg.method || 'GET',
    headers: cfg.headers || {},
    authHeader: cfg.authHeader,
    apiKey: cfg.apiKey,
    apiKeyHeader: cfg.apiKeyHeader || 'X-API-Key',
    body: cfg.body,
    poll_interval_sec: parseInt(cfg.poll_interval_sec || '60', 10),
    points_path: cfg.points_path || 'points',
  };
}

function buildMqttSourceConfig(cfg) {
  return {
    type: 'mqtt_live',
    name: cfg.name || 'MQTT',
    brokerUrl: normalizeBrokerUrl(cfg.brokerUrl || cfg.url),
    topic: cfg.topic,
    username: cfg.username,
    password: cfg.password,
    clientId: cfg.clientId,
    qos: parseInt(cfg.qos ?? '0', 10),
    cleanSession: cfg.cleanSession !== false,
    protocolVersion: cfg.protocolVersion || 4,
  };
}

function extractPointsFromPayload(payload, pointsPath) {
  if (!payload || typeof payload !== 'object') return {};
  if (pointsPath && payload[pointsPath]) return payload[pointsPath];
  if (payload.points && typeof payload.points === 'object') return payload.points;
  return payload;
}

module.exports = {
  IMPORT_DIR,
  EXCEL_FORMAT,
  REQUIRED_LONG_COLUMNS,
  ensureImportDir,
  parseUploadBuffer,
  detectFormat,
  normalizeRows,
  normalizeBrokerUrl,
  testMqtt,
  testHttps,
  buildHttpsSourceConfig,
  buildMqttSourceConfig,
  extractPointsFromPayload,
  sanitizePointKey,
};

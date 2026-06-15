/**
 * db-provisioner.js
 * ─────────────────────────────────────────────────────────
 * Auto-provisions a PostgreSQL schema + device_readings table
 * from a device registry payload.
 *
 * GCP-ready: every table always has
 *   tenant_id, plant_id, device_id columns
 *   so rows map 1-to-1 to BigQuery schema without transformation.
 *
 * Usage:
 *   const { provisionPlant } = require('./lib/db-provisioner');
 *   const result = await provisionPlant(pool, payload);
 */

'use strict';

// ── SQL type mapping ──────────────────────────────────────────────────────────
function sqlType(kpiType) {
  if (kpiType === 'status') return 'VARCHAR(20)';
  return 'NUMERIC(14,4)';
}

// ── Sanitise identifier (no SQL injection) ────────────────────────────────────
function safeName(str) {
  return str.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase().substring(0, 63);
}

// ─────────────────────────────────────────────────────────────────────────────
// provisionPlant
// ─────────────────────────────────────────────────────────────────────────────
async function provisionPlant(pool, payload) {
  const { tenant, plant, devices, shifts } = payload;

  const schemaName  = safeName(`${tenant.tenant_id}_${plant.plant_id}`);
  const tableName   = 'device_readings';
  const fullTable   = `"${schemaName}"."${tableName}"`;
  const columnsCreated = [];

  // 1. Create schema (idempotent) ──────────────────────────────────────────────
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

  // 2. Create base table (idempotent) ──────────────────────────────────────────
  //    Always includes GCP-required identity columns
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${fullTable} (
      time          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      tenant_id     VARCHAR(64)   NOT NULL,
      plant_id      VARCHAR(64)   NOT NULL,
      device_id     VARCHAR(64)   NOT NULL,
      device_type   VARCHAR(32),
      shift         VARCHAR(32),
      line_id       VARCHAR(16)
    )
  `);

  // 3. Try to make it a TimescaleDB hypertable (safe — ignores if already done)
  try {
    await pool.query(`
      SELECT create_hypertable(
        '${schemaName}.${tableName}', 'time',
        if_not_exists => TRUE,
        migrate_data   => TRUE
      )
    `);
  } catch (e) {
    // TimescaleDB not available or already hypertable — continue
    console.warn('[DBProv] Hypertable skip:', e.message);
  }

  // 4. Dynamically add columns from device parameters ──────────────────────────
  for (const device of devices) {
    for (const param of device.parameters) {
      const colName = safeName(`${device.device_id}_${param.field}`);
      const colType = sqlType(param.kpi_type);

      try {
        await pool.query(
          `ALTER TABLE ${fullTable} ADD COLUMN IF NOT EXISTS "${colName}" ${colType}`
        );
        columnsCreated.push({ column: colName, type: colType, device: device.device_id, param: param.field });
      } catch (e) {
        console.warn(`[DBProv] Column ${colName} skip:`, e.message);
      }
    }
  }

  // 5. Create users table in schema ────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${schemaName}"."users" (
      id          SERIAL PRIMARY KEY,
      username    VARCHAR(64) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      full_name   VARCHAR(128),
      role        VARCHAR(32) DEFAULT 'operator',
      email       VARCHAR(128),
      phone       VARCHAR(32),
      alerts      VARCHAR(32) DEFAULT 'both',
      active      BOOLEAN DEFAULT TRUE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 6. Create shifts table in schema ───────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${schemaName}"."shifts" (
      id          SERIAL PRIMARY KEY,
      shift_name  VARCHAR(64) NOT NULL,
      start_time  TIME NOT NULL,
      end_time    TIME NOT NULL,
      active      BOOLEAN DEFAULT TRUE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${schemaName}"."shift_breaks" (
      id         SERIAL PRIMARY KEY,
      shift_id   INTEGER REFERENCES "${schemaName}"."shifts"(id) ON DELETE CASCADE,
      break_name VARCHAR(64),
      start_time TIME,
      end_time   TIME
    )
  `);

  // 7. Create device_config table in schema ────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${schemaName}"."device_config" (
      device_id     VARCHAR(64) PRIMARY KEY,
      device_name   VARCHAR(128),
      device_type   VARCHAR(32),
      make          VARCHAR(64),
      model         VARCHAR(64),
      protocol      VARCHAR(32),
      address       VARCHAR(128),
      parameters    JSONB,
      active        BOOLEAN DEFAULT TRUE,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 8. Insert shift data ────────────────────────────────────────────────────────
  for (const sh of (shifts || [])) {
    const shiftResult = await pool.query(
      `INSERT INTO "${schemaName}"."shifts" (shift_name, start_time, end_time)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [sh.name, sh.start, sh.end]
    );
    const shiftId = shiftResult.rows[0]?.id;
    if (shiftId && sh.breaks) {
      for (const br of sh.breaks) {
        await pool.query(
          `INSERT INTO "${schemaName}"."shift_breaks" (shift_id, break_name, start_time, end_time)
           VALUES ($1, $2, $3, $4)`,
          [shiftId, br.name, br.start, br.end]
        );
      }
    }
  }

  // 9. Insert device configs ────────────────────────────────────────────────────
  for (const dev of devices) {
    await pool.query(
      `INSERT INTO "${schemaName}"."device_config"
         (device_id, device_name, device_type, make, model, protocol, address, parameters)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (device_id) DO UPDATE SET
         device_name=$2, device_type=$3, make=$4, model=$5,
         protocol=$6, address=$7, parameters=$8`,
      [dev.device_id, dev.device_name, dev.device_type,
       dev.make||'', dev.model||'', dev.protocol||'', dev.address||'',
       JSON.stringify(dev.parameters)]
    );
  }

  // 10. Set 7-day retention policy (TimescaleDB) ───────────────────────────────
  try {
    await pool.query(`
      SELECT add_retention_policy(
        '${schemaName}.${tableName}',
        INTERVAL '7 days',
        if_not_exists => TRUE
      )
    `);
  } catch (e) {
    console.warn('[DBProv] Retention policy skip:', e.message);
  }

  return {
    schema_name:     schemaName,
    table_name:      tableName,
    full_table:      `${schemaName}.${tableName}`,
    columns_created: columnsCreated.length,
    columns:         columnsCreated,
    devices_count:   devices.length,
    gcp_topic_stub:  `oee-${tenant.tenant_id}-${plant.plant_id}-readings`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildInsertQuery
// Called by Node-RED flow to get the SQL for inserting a live reading
// ─────────────────────────────────────────────────────────────────────────────
function buildInsertQuery(schemaName, deviceId, deviceType, tenantId, plantId, shift, params) {
  const safe = safeName;
  const cols = ['tenant_id','plant_id','device_id','device_type','shift'];
  const vals = [tenantId, plantId, deviceId, deviceType, shift];
  let idx = vals.length + 1;

  for (const [field, value] of Object.entries(params)) {
    cols.push(safe(`${deviceId}_${field}`));
    vals.push(value);
    idx++;
  }

  const placeholders = vals.map((_, i) => `$${i+1}`).join(', ');
  const sql = `INSERT INTO "${schemaName}"."device_readings" (time, ${cols.map(c=>`"${c}"`).join(', ')})
               VALUES (NOW(), ${placeholders})`;

  return { sql, values: vals };
}

// ─────────────────────────────────────────────────────────────────────────────
// generateNodeRedFlow
// Returns a minimal Node-RED flow JSON for the provisioned plant
// ─────────────────────────────────────────────────────────────────────────────
function generateNodeRedFlow(schemaName, tenant, plant, devices) {
  const tabId = `tab_${schemaName}`;
  const nodes = [
    {
      id: tabId, type: 'tab',
      label: `${plant.plant_name} — DB Writer`,
      disabled: false
    },
    {
      id: `${schemaName}_inject`, type: 'inject', z: tabId,
      name: 'Every 30s → Write to DB',
      repeat: '30', once: true, onceDelay: '5',
      payload: '', payloadType: 'date',
      x: 150, y: 100,
      wires: [[`${schemaName}_fn`]]
    },
    {
      id: `${schemaName}_fn`, type: 'function', z: tabId,
      name: 'Build INSERT from live_data',
      func: buildNodeRedFunction(schemaName, tenant.tenant_id, plant.plant_id, devices),
      outputs: 1, x: 380, y: 100,
      wires: [[`${schemaName}_pg`]]
    },
    {
      id: `${schemaName}_pg`, type: 'postgresql', z: tabId,
      name: `Write → ${schemaName}`,
      postgreSQLConfig: 'db_config',
      split: false, rowsPerMsg: 1,
      outputs: 1, x: 620, y: 100,
      wires: [[`${schemaName}_debug`]]
    },
    {
      id: `${schemaName}_debug`, type: 'debug', z: tabId,
      name: 'DB Write Result',
      active: true, tosidebar: true, tostatus: true,
      complete: 'true', x: 820, y: 100, wires: []
    }
  ];
  return nodes;
}

function buildNodeRedFunction(schemaName, tenantId, plantId, devices) {
  const deviceBlocks = devices.map(dev => {
    const fields = dev.parameters.map(p =>
      `"${dev.device_id}_${p.field.replace(/[^a-zA-Z0-9_]/g,'_')}": d.${dev.device_id?.toUpperCase()}_${p.field.toUpperCase()} || 0`
    ).join(',\n        ');
    return `
  // ${dev.device_name}
  var ${dev.device_id}_data = {
    tenant_id: "${tenantId}",
    plant_id:  "${plantId}",
    device_id: "${dev.device_id}",
    device_type:"${dev.device_type}",
    shift: d.SHIFT || "A",
    ${fields}
  };`;
  }).join('\n');

  return `var d = global.get('live_data') || {};
if (!d || Object.keys(d).length === 0) {
  node.warn('No live data yet');
  return null;
}
${deviceBlocks}

// Send first device as example (extend for all devices)
var firstDevice = ${devices[0]?.device_id || 'null'}_data;
if (!firstDevice) { node.warn('No device data'); return null; }

var cols = Object.keys(firstDevice).join(', ');
var vals = Object.values(firstDevice);
var placeholders = vals.map((_,i) => '$'+(i+1)).join(', ');

msg.topic = 'INSERT INTO "${schemaName}"."device_readings" (time, ' + cols + ') VALUES (NOW(), ' + placeholders + ')';
msg.params = vals;
return msg;`;
}

module.exports = { provisionPlant, buildInsertQuery, generateNodeRedFlow, safeName };

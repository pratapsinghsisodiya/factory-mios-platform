'use strict';

const mqtt = require('mqtt');
const crypto = require('crypto');
const { buildMqttSourceConfig } = require('./ingestion-connectors');

function payloadToPoints(payload) {
  if (!payload || typeof payload !== 'object') return {};
  if (payload.points && typeof payload.points === 'object') return payload.points;
  const points = { ...payload };
  delete points.timestamp;
  delete points.time;
  delete points.ts;
  return points;
}

function platformClientId(cfg) {
  const base = String(cfg.clientId || 'factory-mios').trim();
  if (base.endsWith('-platform') || base.includes('-platform-')) return base;
  return `${base}-platform-${crypto.randomBytes(3).toString('hex')}`;
}

function startMqttLiveIngest(db, setupWizard) {
  const clients = new Map();

  function stopAll() {
    for (const client of clients.values()) client.end(true);
    clients.clear();
  }

  async function ensureMachine(plantId, machineId, machineName) {
    const state = setupWizard.loadState();
    const plant = state.plants.find(p => p.plant_id === plantId);
    if (!plant) throw new Error(`Plant not found: ${plantId}`);
    await setupWizard.provisionPlant(db, { plant_id: plantId, plant_name: plant.plant_name || plantId });
    await setupWizard.provisionMachine(db, plantId, {
      machine_id: machineId,
      machine_name: machineName || machineId,
    });
  }

  async function attachSource(source, plantId, machineId) {
    const cfg = source.brokerUrl ? source : buildMqttSourceConfig(source);
    const key = `${plantId}:${machineId}:${cfg.topic}`;
    if (clients.has(key)) return;

    await ensureMachine(plantId, machineId, source.machine_name);

    const client = mqtt.connect(cfg.brokerUrl, {
      username: cfg.username || undefined,
      password: cfg.password || undefined,
      clientId: platformClientId(cfg),
      protocolVersion: parseInt(cfg.protocolVersion || 4, 10),
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 15000,
    });

    client.on('connect', () => {
      console.log(`[MQTT] Live ingest connected → ${cfg.brokerUrl} topic=${cfg.topic} plant=${plantId} machine=${machineId}`);
      client.subscribe(cfg.topic, { qos: parseInt(cfg.qos ?? 0, 10) });
    });

    client.on('message', async (_topic, message) => {
      try {
        const payload = JSON.parse(message.toString('utf8'));
        const points = payloadToPoints(payload);
        const timeIso = payload.timestamp || payload.time || payload.ts;
        if (!Object.keys(points).length) return;
        await setupWizard.insertPoints(db, plantId, machineId, points, timeIso);
      } catch (e) {
        console.error('[MQTT] Ingest error:', e.message);
      }
    });

    client.on('error', err => console.error('[MQTT] Client error:', err.message));
    clients.set(key, client);
  }

  async function reload() {
    stopAll();
    const state = setupWizard.loadState();

    for (const plant of state.plants || []) {
      for (const source of plant.data_sources || []) {
        if (source.type !== 'mqtt_live') continue;
        if (source.status && source.status !== 'connected' && source.status !== 'configured') continue;
        const machineId = source.machine_id || plant.machines?.[0]?.machine_id;
        if (!machineId) continue;
        await attachSource(source, plant.plant_id, machineId).catch(e =>
          console.error(`[MQTT] Failed to start ${plant.plant_id}/${machineId}:`, e.message)
        );
      }
    }
  }

  return { reload, stopAll };
}

module.exports = { startMqttLiveIngest, payloadToPoints, platformClientId };

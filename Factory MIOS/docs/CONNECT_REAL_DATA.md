# Connecting real machine data (no dummy simulator)

The demo `simulator` writes fake telemetry. For a realistic setup, run WITHOUT the
`demo` profile and feed real data over HTTPS or MQTT.

## 1. Start the platform (no dummy data)

```powershell
cd "Factory MIOS"
docker compose up --build          # note: NO --profile demo
```

To also run the bundled MQTT broker:

```powershell
docker compose --profile mqtt up --build
```

## 2. Set up the device in the UI

Sign in → **Assets** (Device setup). Follow the steps:
1. Add Location → Plant → Line.
2. Add the machine (pick MQTT or HTTPS).
3. **Step 3 (Connectivity)** shows the exact broker URL, topic, and a ready curl
   command with this device's API key. Copy them.
4. **Step 4** — add each parameter using the exact JSON key your machine sends.
5. **Step 5** — watch live data arrive (auto-refreshes every 5s).
6. **Step 6** — set shift, master data, and build KPIs.

## 3a. Send data over HTTPS (simplest — no broker)

```bash
curl -X POST http://localhost:8000/api/v1/ingest/http \
  -H "X-API-Key: <DEVICE_API_KEY>" -H "Content-Type: application/json" \
  -d '{"good_count":64,"total_count":70,"cycle_time":28.4,"running":1,"temperature":68.2}'
```

## 3b. Send data over MQTT

Configure `.env` and start the broker:

```env
MQTT_HOST=mqtt
MQTT_PORT=1883
MQTT_TOPIC_PREFIX=mios/telemetry
# optional auth:
MQTT_USERNAME=
MQTT_PASSWORD=
```

```powershell
docker compose --profile mqtt up -d
```

Publish a flat-JSON payload to `mios/telemetry/<DEVICE_API_KEY>`:

```bash
mosquitto_pub -h localhost -p 1883 \
  -t "mios/telemetry/<DEVICE_API_KEY>" \
  -m '{"good_count":64,"total_count":70,"cycle_time":28.4,"running":1}'
```

To point at your **own external broker**, set `MQTT_HOST`/`MQTT_PORT`/credentials in
`.env` to that broker and run the ingestor with `--profile mqtt`.

## 4. Quick test publisher (Python)

`scripts/test_publisher.py` posts realistic readings over HTTPS every few seconds:

```bash
python scripts/test_publisher.py --api-key <DEVICE_API_KEY> --url http://localhost:8000
```

## Payload rules

- Send a flat JSON object; each key is a parameter (must match a `raw_name` you defined).
- Numbers are stored numeric; text (e.g. `"machine_state":"RUNNING"`) is stored as text.
- Optional `timestamp` / `time` / `ts` (ISO or epoch) sets the row time; otherwise "now".

# Local MQTT broker (Mosquitto)

Factory-MIOS includes an optional Mosquitto container for lab testing and local machine simulation.

## Start

```powershell
cd "C:\Users\singh\Documents\GitHub\factory-mios-platform"
docker compose up -d mqtt
```

## Connection URLs

| From | Broker URL |
|------|------------|
| MQTTX / Python on your PC | `mqtt://localhost:1884` |
| Factory-MIOS app (inside Docker) | `mqtt://mqtt:1883` |

Default credentials (override in `.env`):

- User: `factory_mios`
- Password: see `MQTT_PASSWORD` in `.env`

## Add as a data connector

1. Open **http://localhost:8090/welcome** → step 2 (Connectors)
2. Choose **MQTT live feed**
3. Broker URL: `mqtt://mqtt:1883` (from app container) or external broker
4. Set topic, username, password, and target plant/machine

## Publish a test message

```powershell
docker exec factory-mios-platform-mqtt mosquitto_pub `
  -h 127.0.0.1 -p 1883 -u factory_mios -P "YOUR_PASSWORD" `
  -t factory/test -m '{"machine_state":"RUNNING","spindle_speed":1200}'
```

## Troubleshooting

- Container restarting: check `docker logs factory-mios-platform-mqtt`
- Auth errors: rebuild with `docker compose up -d --build mqtt`
- Port conflict: set `MQTT_PORT=1885` in `.env` and restart

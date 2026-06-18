"""Standalone MQTT subscriber. Subscribes to <prefix>/# and writes telemetry.

All broker settings come from the environment (.env) — nothing hardcoded:
    MQTT_HOST, MQTT_PORT, MQTT_USERNAME, MQTT_PASSWORD, MQTT_TLS, MQTT_TOPIC_PREFIX
If MQTT_HOST is empty (and MQTT_ENABLED is false), the ingestor exits cleanly so
the platform runs fine without any MQTT broker — add your own when ready.

Message payload (JSON), published to topic  <prefix>/<device_api_key> :
    {"parameter": "good_count", "value": 42}
  or a batch:
    {"points": [{"parameter": "temp", "value": 70.1}, {"parameter": "rpm", "value": 1500}]}
The device is identified by its api_key in the final topic segment.
"""
import json
import sys
import logging
from datetime import datetime, timezone
import paho.mqtt.client as mqtt
from app.core.config import settings
from app.core.database import SessionLocal
from app.models.models import Device, Telemetry
from app.services.ingest_util import normalize

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("mqtt_ingestor")


def _handle(api_key: str, payload: dict):
    db = SessionLocal()
    try:
        dev = db.query(Device).filter(Device.api_key == api_key).first()
        if not dev:
            log.warning("Unknown device api_key in topic: %s", api_key)
            return
        parsed, ts = normalize(payload)
        rows = []
        for parameter, value, value_text in parsed:
            rows.append(Telemetry(
                tenant_id=dev.tenant_id, device_id=dev.id, parameter=parameter,
                value=value, value_text=value_text, ts=ts,
            ))
        if rows:
            db.add_all(rows)
            dev.status = "online"
            dev.last_seen = datetime.now(timezone.utc)
            db.commit()
            log.info("Ingested %d points from %s", len(rows), dev.name)
    finally:
        db.close()


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def on_connect(client, userdata, flags, reason_code, properties=None):
    topic = f"{settings.MQTT_TOPIC_PREFIX}/#"
    client.subscribe(topic)
    log.info("Connected; subscribed to %s", topic)


def on_message(client, userdata, msg):
    try:
        api_key = msg.topic.split("/")[-1]
        payload = json.loads(msg.payload.decode("utf-8"))
        _handle(api_key, payload)
    except Exception as e:  # noqa: BLE001
        log.error("Failed to process message on %s: %s", msg.topic, e)


def main():
    if not settings.MQTT_HOST and not settings.MQTT_ENABLED:
        log.info("MQTT not configured (MQTT_HOST empty). Ingestor idle — set MQTT_* "
                 "in .env and run with the 'mqtt' compose profile to enable. Exiting.")
        return
    if not settings.MQTT_HOST:
        log.error("MQTT_ENABLED is true but MQTT_HOST is empty. Set MQTT_HOST in .env.")
        sys.exit(1)

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    if settings.MQTT_USERNAME:
        client.username_pw_set(settings.MQTT_USERNAME, settings.MQTT_PASSWORD or None)
    if settings.MQTT_TLS:
        client.tls_set()  # uses system CA bundle; configure certs as needed
    client.on_connect = on_connect
    client.on_message = on_message
    log.info("Connecting to MQTT broker %s:%s (tls=%s)", settings.MQTT_HOST,
             settings.MQTT_PORT, settings.MQTT_TLS)
    client.connect(settings.MQTT_HOST, settings.MQTT_PORT, 60)
    client.loop_forever()


if __name__ == "__main__":
    main()

"""Standalone MQTT subscriber. Subscribes to <prefix>/# and writes telemetry.

Message payload (JSON), published to topic  <prefix>/<device_api_key> :
    {"parameter": "good_count", "value": 42}
  or a batch:
    {"points": [{"parameter": "temp", "value": 70.1}, {"parameter": "rpm", "value": 1500}]}
The device is identified by its api_key in the final topic segment.
"""
import json
import logging
from datetime import datetime, timezone
import paho.mqtt.client as mqtt
from app.core.config import settings
from app.core.database import SessionLocal
from app.models.models import Device, Telemetry

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("mqtt_ingestor")


def _handle(api_key: str, payload: dict):
    db = SessionLocal()
    try:
        dev = db.query(Device).filter(Device.api_key == api_key).first()
        if not dev:
            log.warning("Unknown device api_key in topic: %s", api_key)
            return
        points = payload.get("points") or [payload]
        rows = []
        for p in points:
            if "parameter" not in p:
                continue
            rows.append(Telemetry(
                tenant_id=dev.tenant_id, device_id=dev.id, parameter=str(p["parameter"]),
                value=_num(p.get("value")), value_text=p.get("value_text"),
                ts=datetime.now(timezone.utc),
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
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(settings.MQTT_HOST, settings.MQTT_PORT, 60)
    client.loop_forever()


if __name__ == "__main__":
    main()

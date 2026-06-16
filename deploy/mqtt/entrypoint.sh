#!/bin/sh
set -e

USER="${MQTT_USER:-factory_mios}"
PASS="${MQTT_PASSWORD:-factory_mios123}"
PASSFILE="/mosquitto/data/passwordfile"

mkdir -p /mosquitto/data /mosquitto/log
mosquitto_passwd -b -c "$PASSFILE" "$USER" "$PASS"
chmod 644 "$PASSFILE"

echo "[mqtt] Mosquitto ready — user=$USER port=1883"

exec /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf

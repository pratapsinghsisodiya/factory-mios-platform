#!/bin/sh
set -e

mkdir -p /app/config/generated_flows /app/imports

# Named volumes and Windows mounts: ensure node user can always write config
chown -R node:node /app/config /app/imports 2>/dev/null || true
chmod -R a+rwX /app/config /app/imports 2>/dev/null || true

if [ -d /app/config-default ]; then
  for f in /app/config-default/*; do
    [ -e "$f" ] || continue
    base=$(basename "$f")
    if [ ! -e "/app/config/$base" ]; then
      cp -a "$f" "/app/config/$base"
    fi
  done
  chown -R node:node /app/config 2>/dev/null || true
  chmod -R a+rwX /app/config 2>/dev/null || true
fi

exec gosu node "$@"

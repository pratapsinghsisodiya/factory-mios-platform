#!/usr/bin/env bash
set -euo pipefail

DB_HOST="${DB_HOST:-db}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-cnc_db}"
DB_USER="${DB_USER:-cnc_user}"
DB_PASSWORD="${DB_PASSWORD:-change-this-db-password}"
POOL_MODE="${POOL_MODE:-transaction}"
MAX_CLIENT_CONN="${MAX_CLIENT_CONN:-1000}"
DEFAULT_POOL_SIZE="${DEFAULT_POOL_SIZE:-50}"
RESERVE_POOL_SIZE="${RESERVE_POOL_SIZE:-10}"

cat > /tmp/userlist.txt <<USERS
"${DB_USER}" "${DB_PASSWORD}"
USERS
chmod 600 /tmp/userlist.txt

cat > /tmp/pgbouncer.ini <<CFG
[databases]
${DB_NAME} = host=${DB_HOST} port=${DB_PORT} dbname=${DB_NAME}

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = plain
auth_file = /tmp/userlist.txt
pool_mode = ${POOL_MODE}
max_client_conn = ${MAX_CLIENT_CONN}
default_pool_size = ${DEFAULT_POOL_SIZE}
reserve_pool_size = ${RESERVE_POOL_SIZE}
server_reset_query = DISCARD ALL
ignore_startup_parameters = extra_float_digits,options
admin_users = ${DB_USER}
stats_users = ${DB_USER}
log_connections = 1
log_disconnections = 1
CFG

exec /usr/sbin/pgbouncer /tmp/pgbouncer.ini

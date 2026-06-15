#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

read_default() {
  local prompt="$1"
  local default="$2"
  local value
  read -r -p "$prompt [$default]: " value
  if [[ -z "${value// }" ]]; then
    printf '%s' "$default"
  else
    printf '%s' "$value"
  fi
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 36 | tr '+/' '-_' | tr -d '='
  else
    node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"
  fi
}

read_secret_or_generate() {
  local prompt="$1"
  local value
  read -r -s -p "$prompt (leave blank to auto-generate): " value
  echo >&2
  if [[ -z "$value" ]]; then
    random_secret
  else
    printf '%s' "$value"
  fi
}

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker Desktop or Docker Engine and try again." >&2
  exit 1
fi

docker compose version >/dev/null

echo
echo "Factory-MIOS local Docker setup"
echo "This will create .env and start gateway + app + PgBouncer + TimescaleDB."
echo

if [[ -f .env ]]; then
  overwrite=$(read_default "Existing .env found. Overwrite? (y/n)" "n")
  if [[ "${overwrite,,}" != "y" ]]; then
    echo "Keeping existing .env. Starting Docker with current configuration."
    docker compose up -d --build
    exit 0
  fi
fi

http_port=$(read_default "Dashboard host port" "8080")
app_port=$(read_default "Internal app port" "3000")
db_port=$(read_default "PostgreSQL host port" "5432")
adminer_port=$(read_default "Adminer host port" "8081")
nodered_port=$(read_default "Node-RED host port" "1880")
db_name=$(read_default "Database name" "factory_mios")
db_user=$(read_default "Database user" "factory_mios")
db_password=$(read_secret_or_generate "Database password")
jwt_secret=$(read_secret_or_generate "JWT secret")
enable_demo_users=$(read_default "Enable demo admin users for local testing? (true/false)" "false")
nodered_url=$(read_default "Node-RED live URL" "http://host.docker.internal:1880/api/live")
tb_token=$(read_default "ThingsBoard token (optional)" "")
gemini_key=$(read_default "Gemini API key for chatbot (optional)" "")
anthropic_key=$(read_default "Anthropic API key for chatbot (optional)" "")

cat > .env <<ENVEOF
COMPOSE_PROJECT_NAME=factory-mios
NODE_ENV=production
PORT=$app_port
HTTP_PORT=$http_port
TZ=Asia/Kolkata

POSTGRES_DB=$db_name
POSTGRES_USER=$db_user
POSTGRES_PASSWORD=$db_password
POSTGRES_PORT=$db_port
ADMINER_PORT=$adminer_port
NODE_RED_PORT=$nodered_port

PGHOST=pgbouncer
PGPORT=6432
PGDATABASE=$db_name
PGUSER=$db_user
PGPASSWORD=$db_password
PGPOOL_MAX=10
PGPOOL_IDLE_TIMEOUT_MS=30000
PGPOOL_CONNECTION_TIMEOUT_MS=5000

PGBOUNCER_MAX_CLIENT_CONN=1000
PGBOUNCER_DEFAULT_POOL_SIZE=50
PGBOUNCER_RESERVE_POOL_SIZE=10

DATA_CONNECTOR_SECRET=$jwtSecret
JWT_SECRET=$jwt_secret
JWT_EXPIRE=24h
JSON_BODY_LIMIT=1mb
RATE_LIMIT_MAX=1000
AUTH_RATE_LIMIT_MAX=20
AI_RATE_LIMIT_MAX=60
ALLOW_QUERY_TOKEN_AUTH=false
ENABLE_DEFAULT_USERS=$enable_demo_users

NODE_RED_URL=$nodered_url
DATA_IMPORT_DIR=/app/imports
DATA_SOURCE_PREVIEW_ROWS=100
DATA_SOURCE_CACHE_TTL_MS=30000
DATA_SOURCE_SQL_TIMEOUT_MS=10000
DATA_SOURCE_MQTT_TIMEOUT_MS=10000
GEMINI_API_KEY=$gemini_key
ANTHROPIC_API_KEY=$anthropic_key
TB_TOKEN=$tb_token
TB_MACHINE_ID=MACHINE001

MQTT_BROKER=mqtt://host.docker.internal:1883
MQTT_TOPIC=factory-machine001
ENVEOF

echo "Created .env"
echo "Starting Factory-MIOS Docker stack..."
docker compose up -d --build

echo "Waiting for dashboard health endpoint..."
health_url="http://localhost:$http_port/health"
healthy=0
for _ in $(seq 1 40); do
  if curl -fsS "$health_url" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 3
done

if [[ "$healthy" == "1" ]]; then
  echo "Dashboard is reachable: http://localhost:$http_port"
else
  echo "Dashboard did not become healthy yet. Check logs: docker compose logs -f app" >&2
fi

policy_path="deploy/db/policies/001-timescale-telemetry-policies.sql"
if [[ -f "$policy_path" ]]; then
  echo "Applying TimescaleDB policies if tables exist..."
  docker compose exec -T db psql -U "$db_user" -d "$db_name" < "$policy_path" || {
    echo "Policy application skipped/failed. Rerun after tables exist:" >&2
    echo "docker compose exec -T db psql -U '$db_user' -d '$db_name' < $policy_path" >&2
  }
fi

echo
echo "Factory-MIOS is ready."
echo "Dashboard: http://localhost:$http_port"
echo "Logs:      docker compose logs -f app"
echo "Stop:      docker compose down"
echo "Adminer:   docker compose --profile tools up -d  then http://localhost:$adminer_port"
echo "Node-RED:  docker compose --profile iot up -d    then http://localhost:$nodered_port"

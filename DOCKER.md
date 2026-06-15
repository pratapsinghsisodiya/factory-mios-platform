# Docker deployment

For local PC setup without PostgreSQL installed, start with `LOCAL_DOCKER_QUICKSTART.md`.

This copied app can run as a containerized OEE dashboard with a TimescaleDB/PostgreSQL service.

## 1. Create environment file

```bash
cp .env.example .env
```

Edit `.env` and replace every `replace_with_*` value. At minimum, set:

- `POSTGRES_PASSWORD`
- `PGPASSWORD`
- `JWT_SECRET`
- `TB_TOKEN` if ThingsBoard push is enabled
- AI API keys only if AI chat is enabled

Do not commit `.env`.

## 2. Start the stack

```bash
docker compose up -d --build
```

Open:

```text
http://localhost:8080
```

## 3. Check health and logs

```bash
docker compose ps
docker compose logs -f app
curl http://localhost:8080/health
```

## 4. Optional services

Start Node-RED with:

```bash
docker compose --profile iot up -d
```

Start Adminer with:

```bash
docker compose --profile tools up -d
```

## 5. Persistent data

Docker volumes are used for runtime state:

- `postgres_data` stores TimescaleDB/PostgreSQL data.
- `app_config` stores mutable app config files under `/app/config`.

To reset a local development stack completely:

```bash
docker compose down -v
```

## 6. Apply Timescale policies

After the app has created database tables, apply hypertable/index/compression policies:

```bash
docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < deploy/db/policies/001-timescale-telemetry-policies.sql
```

## 7. Production notes

- Put this stack behind a TLS reverse proxy such as Caddy, Traefik, or a host-level Nginx when exposing it publicly.
- Use strong, unique passwords and rotate any secret that was pasted into chat/logs.
- Do not use default app users/passwords for production SaaS.
- Back up both the database volume and the app config volume.
- Prefer managed PostgreSQL/TimescaleDB for production SaaS if you need backups, HA, and monitoring.

## Scaling

For large deployments, read `SCALING.md`. Docker uses TimescaleDB by default plus PgBouncer connection pooling.

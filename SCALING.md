# Factory-MIOS scaling guide

## Default database

Factory-MIOS uses **TimescaleDB by default** in Docker:

```yaml
image: timescale/timescaledb:latest-pg15
```

TimescaleDB is PostgreSQL plus time-series features. You still use PostgreSQL SQL, drivers, indexes, joins, and tools, but high-volume time-series tables can be hypertables with chunking, compression, retention policies, and continuous aggregates.

For telemetry and OEE workloads, TimescaleDB is a better default than plain PostgreSQL because machine readings are time-series data.

## Current microservice/container layout

```text
[gateway]  Nginx reverse proxy / public entry
[app]      Node.js Express + WebSocket monolith
[pgbouncer] lightweight PostgreSQL connection pool
[db]       TimescaleDB/PostgreSQL
[nodered]  optional IoT flow runtime profile
[adminer]  optional DB inspection profile
```

This is a practical Docker microservice foundation. The code inside `app` is still a monolith, but infrastructure is separated so the next split can be done safely.

## Why PgBouncer was added

Node.js can open many PostgreSQL connections under concurrent traffic. PostgreSQL connections are memory-heavy. PgBouncer keeps the app lightweight by pooling connections and reusing a smaller number of database connections.

App settings:

```env
PGHOST=pgbouncer
PGPORT=6432
PGPOOL_MAX=10
```

PgBouncer settings:

```env
PGBOUNCER_MAX_CLIENT_CONN=1000
PGBOUNCER_DEFAULT_POOL_SIZE=50
PGBOUNCER_RESERVE_POOL_SIZE=10
```

## Billion-row strategy

A billion rows is possible only with the right data model and query patterns. Docker alone does not make a platform handle billions of rows.

Required practices:

1. **Use hypertables for raw telemetry**
   - Time column partitioning/chunking.
   - Typical chunk size: 1 day for high-volume telemetry.

2. **Use compression**
   - Compress raw telemetry after a few days.
   - Keep hot data uncompressed for fast writes.

3. **Use retention policies**
   - Keep raw high-frequency data only as long as needed.
   - Keep aggregated OEE/report data much longer.

4. **Use continuous aggregates**
   - Precompute hourly/daily OEE and machine metrics.
   - Dashboards should read aggregates, not scan raw rows.

5. **Use cursor/time-window queries**
   - Always filter by time range and machine/tenant.
   - Avoid unlimited `SELECT *` and large offsets.

6. **Separate ingestion from UI**
   - Future split: ingestion worker writes telemetry.
   - UI/API should read optimized aggregates.

7. **Tenant-aware indexes**
   - For SaaS tables, index by tenant/plant/machine/time.

## Policy SQL

Initial DB bootstrap:

```text
deploy/db/init/001-timescale-extension.sql
```

Post-table Timescale policies:

```text
deploy/db/policies/001-timescale-telemetry-policies.sql
```

Run policy script after the app has created tables:

```bash
docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < deploy/db/policies/001-timescale-telemetry-policies.sql
```

## Recommended future microservice split

To become truly microservice based, split the Node monolith into domain services:

1. **auth-service**
   - users, roles, tenants, JWT/session logic

2. **tenant-service**
   - tenants, plants, machines, permissions

3. **ingestion-service**
   - MQTT/Node-RED ingestion, validation, batch writes

4. **telemetry-query-service**
   - optimized reads from TimescaleDB/continuous aggregates

5. **report-service**
   - Excel/PDF/email reports, async jobs

6. **ai-service**
   - chatbot, read-only DB access, table allowlists

7. **notification-service**
   - SMTP, WhatsApp, alerts

## Performance targets to test

Before production SaaS, run load tests for:

- telemetry writes per second
- dashboard concurrent users
- chatbot queries per minute
- report generation concurrency
- tenant isolation query speed
- p95/p99 response times

Use realistic data volume, not empty development tables.

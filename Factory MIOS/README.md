# Factory MIOS — Manufacturing Intelligence Operating System

A secure, container-based, multi-tenant SaaS foundation for manufacturing intelligence:
public product brief, client onboarding via unique links, device + GPS registration,
multi-protocol data ingestion (MQTT / HTTPS / CSV-Excel), a no-code KPI/formula engine,
master-data mapping, shift planning, a multi-industry widget + dashboard-template
catalog, and an in-app AI assistant.

> **Status:** working foundation / MVP. It establishes the architecture and core flows
> end-to-end so it can be extended into the full vision (more widgets, real-time
> dashboard builder, richer ingestion, advanced analytics). See `docs/ROADMAP.md`.

## Quick start (local or cloud — one command)

```bash
cp .env.example .env          # then edit secrets (SECRET_KEY, passwords)
docker compose up --build
```

Then open:

- Frontend / product brief: http://localhost:3000
- API docs (Swagger): http://localhost:8000/docs
- Health: http://localhost:8000/health

**Demo login:** `demo@factory-mios.local` / `Demo!2026`
**Platform admin:** value of `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`

## Services (docker-compose)

| Service          | What it is                                  |
|------------------|---------------------------------------------|
| `db`             | PostgreSQL + TimescaleDB (telemetry store)  |
| `redis`          | Cache / future queues                       |
| `mqtt`           | Eclipse Mosquitto broker                    |
| `backend`        | FastAPI API (auth, onboarding, ingest, KPI) |
| `mqtt_ingestor`  | Subscribes to MQTT and writes telemetry     |
| `frontend`       | Next.js app (brief, onboarding, dashboards) |

## Core flows

1. **Onboard a client** — Admin → *Onboarding* page → generate a unique link → send it.
   The client opens `/onboard/<token>`, submits the registration form → a tenant +
   admin account are created in the DB and they're signed in.
2. **Register a device** — `POST /api/v1/devices` with name, machine type, GPS, and
   connection type (`mqtt|https|csv`). Each device gets an `api_key`.
3. **Send data**
   - MQTT: publish JSON to `mios/telemetry/<device_api_key>`
   - HTTPS: `POST /api/v1/ingest/http` with header `X-API-Key: <device_api_key>`
   - CSV/Excel: `POST /api/v1/ingest/csv?device_id=...` (multipart upload)
4. **Master data** — import a part catalog (`/api/v1/master-data/import`) and map fields
   (e.g. `target_cycle_time`) into KPIs.
5. **Build KPIs** — *KPI Builder* page: write `good/total*100`, map each variable to a
   telemetry parameter, master-data field, or constant.
6. **Dashboards** — create from OEE / Downtime / Quality / Performance / Real-Time /
   EMS / WMS templates; widgets render from the catalog.

## Repository layout

```
backend/   FastAPI app (app/core, app/models, app/api/routes, app/services)
frontend/  Next.js app router (app/, components/, lib/)
mosquitto/ broker config
db/        TimescaleDB init
docs/      architecture, security, roadmap
```

See `docs/ARCHITECTURE.md` and `docs/SECURITY.md`.

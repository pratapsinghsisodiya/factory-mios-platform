# OEE SaaS Docker architecture

This folder is a copied, container-ready version of the existing OEE dashboard. The original app code outside this folder is not required to run this stack.

## Container services

```text
Browser
  |
  v
[gateway: nginx]
  |
  v
[app: Node.js Express + WebSocket]
  |
  v
[pgbouncer: DB connection pool]
  |
  v
[db: TimescaleDB/PostgreSQL]
  |
  +--> [Node-RED / IoT source, optional]
  |
  +--> [AI providers: Gemini / Claude / Groq / Ollama, optional]
  |
  +--> [SMTP / WhatsApp / ThingsBoard, optional]
```

### `gateway`

Nginx edge service. It exposes `HTTP_PORT` from `.env` and forwards HTTP/WebSocket traffic to the Node app.

Why it exists:

- one public entry point
- WebSocket proxy support
- place to add TLS/security headers later
- app container can stay internal

### `app`

The existing Factory-MIOS platform running as a Node.js service. It serves:

- static HTML pages from `public/`
- REST APIs from `server.js`
- WebSocket live data stream
- report generation
- alert execution
- chatbot endpoints
- SaaS admin screens/APIs

### `pgbouncer`

Lightweight PostgreSQL connection pool. The app connects to PgBouncer, and PgBouncer reuses a smaller number of database connections for TimescaleDB.

### `db`

TimescaleDB/PostgreSQL for OEE, CNC, tenant, machine, report, and history data. TimescaleDB is the default because telemetry is time-series data.

### `nodered` profile

Optional IoT/flow service. Start it with:

```bash
docker compose --profile iot up -d
```

### `adminer` profile

Optional DB admin UI. Start it with:

```bash
docker compose --profile tools up -d
```

Open Adminer at `http://localhost:8081` by default.

## Database connection flow

The copied `server.js` creates two PostgreSQL pools:

- `db` for general app/SaaS tables
- `dbCNC` for CNC/OEE data

Both pools are built by `buildPoolConfig()`.

Priority order:

1. `DATABASE_URL` / `CNC_DATABASE_URL`
2. PG environment variables: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`
3. legacy local defaults for non-container development

In Docker Compose, the app connects to the database service by hostname:

```text
PGHOST=db
PGPORT=5432
```

Docker DNS resolves `db` to the TimescaleDB container.

## Chatbot flow

There are two main chatbot endpoints:

- `POST /api/chat`
- `POST /api/cnc/chat`

High-level flow:

```text
User question from chat.html
  |
  v
Express route in server.js
  |
  +--> freeAIAnswer() in lib/free-ai-agent.js
  |      - can use Groq/Gemini/Ollama when configured
  |      - generates SQL for report/chart/chat modes
  |
  +--> aiAnswer() in lib/claude-agent.js
  |      - can use Gemini or Claude when API keys exist
  |      - turns natural language into SELECT SQL
  |
  +--> cncAnswer() fallback in lib/cnc-fallback.js
         - rule-based answers when no AI provider works
```

The AI engines generate SQL and run it against the database pool. This is powerful but sensitive. Before real SaaS launch, restrict this with:

- read-only DB user
- table/column allowlist
- strict row limits
- query timeout
- tenant filtering

## Main feature map

| Feature | Main files |
| --- | --- |
| Login/auth | `lib/auth.js`, login routes in `server.js`, `public/login.html` |
| Live dashboard | WebSocket section in `server.js`, dashboard pages in `public/` |
| CNC/OEE APIs | `/api/cnc/*` routes in `server.js` |
| Reports | `lib/report-generator.js`, report routes in `server.js`, `public/reports.html` |
| Alerts | `lib/alert-engine.js`, `lib/mailer.js`, `lib/whatsapp.js`, alert routes in `server.js` |
| SaaS admin | `/api/saas/*` routes in `server.js`, `public/saas-platform.html` |
| Device provisioning | `lib/db-provisioner.js`, `/api/device/register` route |
| Chatbot | `lib/free-ai-agent.js`, `lib/claude-agent.js`, `lib/cnc-fallback.js`, chat routes |

## Current SaaS status

This is a Docker/microservice foundation, not a fully secure SaaS split yet. The app still has a monolithic Node service internally. The next step is to split high-risk capabilities into separate services:

1. `auth-service` for users, sessions, JWT, tenant roles
2. `tenant-service` for tenants/plants/machines
3. `telemetry-service` for CNC/OEE ingestion and queries
4. `report-service` for Excel/email reports
5. `ai-service` for chatbot with read-only DB access
6. `notification-service` for SMTP/WhatsApp

Until those are split, use the hardening checklist in `SAAS_HARDENING.md` before production SaaS launch.

## Scaling

See `SCALING.md` for the billion-row strategy, TimescaleDB policies, PgBouncer pool settings, and future service split plan.

## Data source connectors

See `DATA_SOURCE_CONNECTORS.md` for JSON, Excel/CSV, MQTT, and external SQL connector setup.

## Tenant onboarding

See `TENANT_ONBOARDING.md` for module selection, page visibility, tag mapping, shift definitions, and EMS/WMS totalizer calculations per tenant.

# Factory-MIOS product blueprint

**Factory-MIOS** means **Factory Manufacturing Intelligent Operating System**.

The product goal is to be a SaaS-ready manufacturing intelligence platform that connects shop-floor machines, computes OEE and operational KPIs, helps teams act on downtime/quality/maintenance signals, and gives managers an AI-assisted operating layer for factories.

## Product positioning

Factory-MIOS should become the operating system for manufacturing teams:

```text
Connect machines -> collect telemetry -> calculate KPIs -> detect problems -> guide action -> report outcomes -> improve continuously
```

## What already exists

| Capability | Current status | Current files / areas | Notes |
| --- | --- | --- | --- |
| Live OEE dashboard | Exists | `public/index.html`, `/api/live`, WebSocket in `server.js` | Good base for real-time factory overview. |
| CNC telemetry APIs | Exists | `/api/cnc/*` routes in `server.js` | Many machine/OEE/history endpoints already exist. |
| Reports | Exists | `public/reports.html`, `lib/report-generator.js`, report routes | HTML/Excel/email reports are present. |
| Alerts & notifications | Exists | `public/alerts.html`, `lib/alert-engine.js`, `lib/mailer.js`, `lib/whatsapp.js` | Needs stronger auth and secret storage before SaaS. |
| Chatbot / AI assistant | Exists | `public/chat.html`, `lib/free-ai-agent.js`, `lib/claude-agent.js`, `lib/cnc-fallback.js` | Powerful, but SQL access needs strict controls. |
| SaaS tenant admin UI | Partial | `public/saas-platform.html`, `/api/saas/*` | UI and CRUD exist, but tenant isolation/roles need hardening. |
| Plant/device provisioning | Partial | `public/device-setup.html`, `lib/db-provisioner.js` | Can create schemas/tables/flows. Needs admin-only controls and audit. |
| Quality logs | Exists | `public/quality-entry.html`, `public/rejection-log.html`, `/api/cnc/rejection*` | Useful quality module foundation. |
| Downtime logs/RCA | Exists | `public/downtime-log.html`, `public/downtime-analysis.html`, `/api/cnc/downtime*` | Needs workflow/status ownership for enterprise use. |
| Predictive maintenance | Partial | `public/predictive.html`, `lib/predictive.js` | Basic analytics exist; needs model lifecycle and event history. |
| Digital twin | Partial | `public/digital-twin.html` | UI exists; needs standardized asset model and real telemetry mapping. |
| Dashboard builder | Exists | `public/dashboard-builder.html`, `public/widgets.html`, `/api/dashboards/*` | Needs auth/tenant scoping. |
| User management | Partial | `public/users.html`, `lib/auth.js`, `config/users.json` | Must move from JSON to DB for SaaS. |
| Docker deployment | Exists in copied app | `Dockerfile`, `docker-compose.yml`, `DOCKER.md` | Includes gateway/app/PgBouncer/TimescaleDB. |
| Time-series DB foundation | Exists | TimescaleDB service, `deploy/db/*`, `SCALING.md` | Needs production sizing and load testing. |

## What must be upgraded for a real SaaS MIOS

### 1. Identity, access, and tenants

Required upgrades:

- Move users from `config/users.json` to PostgreSQL tables.
- Add tenant-scoped RBAC: `superadmin`, `tenant_admin`, `plant_admin`, `manager`, `operator`, `viewer`.
- Enforce tenant/plant/machine access in every API query.
- Add invitation/password reset/MFA support.
- Add audit logs for all admin actions.

### 2. SaaS subscription layer

Missing today:

- subscription plans
- usage limits
- billing integration
- per-tenant quotas
- plan-based page/module enablement

Suggested modules:

- `billing-service`
- `tenant-service`
- `usage-metering-service`

### 3. Data ingestion at scale

Required for billions of records:

- separate ingestion worker/service
- batch inserts or queue-based writes
- MQTT/Kafka/NATS ingestion option
- dead-letter queue for bad payloads
- schema validation for telemetry
- idempotent writes

Recommended future services:

```text
ingestion-service
telemetry-query-service
aggregation-service
```

### 4. TimescaleDB optimization

Already started:

- TimescaleDB default container
- PgBouncer
- hypertable policy SQL
- compression policy SQL

Still needed:

- continuous aggregates for dashboard/report queries
- retention policies per tenant/plan
- tenant/machine/time indexes
- query budget/timeouts
- database migration system
- backup/restore automation

### 5. AI assistant hardening

Current chatbot can generate SQL. Before SaaS:

- use a read-only DB role
- add table/column allowlists
- inject tenant filters automatically
- enforce max rows and query timeouts
- block PII/secrets leakage
- log AI prompts/responses safely
- add human-readable explanations for generated charts/reports

### 6. Manufacturing workflows

Factory-MIOS should eventually include:

- shift handover workflow
- downtime approval workflow
- quality disposition workflow
- maintenance ticket workflow
- escalation rules
- operator task boards
- Andon-style incident flow
- production plan vs actual tracking
- ERP/MES connector layer

Some screens exist, but workflow state machines and approvals need to be added.

### 7. Observability and operations

Missing for SaaS production:

- centralized logs
- metrics dashboards
- error tracking
- uptime checks
- per-tenant usage metrics
- DB slow-query monitoring
- audit log review
- backup verification

Recommended stack:

```text
Prometheus + Grafana
Loki or OpenSearch logs
Sentry or OpenTelemetry tracing
pg_stat_statements for DB query insight
```

## Proposed future microservice architecture

```text
                      +----------------+
Users / Browsers ---> | gateway / edge  |
                      +--------+-------+
                               |
              +----------------+----------------+
              |                                 |
       +------+-------+                  +------+-------+
       | web-app/API  |                  | auth-service |
       +------+-------+                  +------+-------+
              |                                 |
       +------+--------------------------+------+
       |
+------+----------+     +----------------+     +----------------+
| tenant-service  |     | telemetry API   |     | ai-service     |
+------+----------+     +-------+--------+     +-------+--------+
       |                        |                      |
+------+----------+     +-------+--------+     +-------+--------+
| billing/usage   |     | ingestion svc  |     | report svc     |
+-----------------+     +-------+--------+     +----------------+
                                |
                       +--------+---------+
                       | queue / stream   |
                       +--------+---------+
                                |
                       +--------+---------+
                       | TimescaleDB      |
                       +------------------+
```

## Recommended phased roadmap

### Phase 1: Containerized Factory-MIOS foundation

- Docker gateway/app/PgBouncer/TimescaleDB
- environment-based config
- branding as Factory-MIOS
- documentation and local test flow

Status: mostly done in `saas-docker-app/`.

### Phase 2: SaaS security foundation

- database users table
- tenant-scoped RBAC
- protect all write/destructive APIs
- tenant filters in every query
- remove JSON user store from production

### Phase 3: Scalable telemetry platform

- ingestion service
- hypertables/continuous aggregates
- compression/retention policies
- dashboard queries from aggregates
- load tests with realistic data

### Phase 4: AI operations layer

- safe AI SQL service
- tenant-aware AI context
- guided RCA
- anomaly summaries
- recommended operator actions

### Phase 5: Enterprise SaaS

- billing/subscriptions
- audit/usage reporting
- connectors to ERP/MES/CMMS
- high availability and backups
- tenant onboarding automation

## Product naming standard

Use these names consistently:

- Product: **Factory-MIOS**
- Full form: **Factory Manufacturing Intelligent Operating System**
- Assistant: **Facto-Bot**
- Demo tenant: **Factory-MIOS Demo**
- Demo machine: **MACHINE001**
- Demo plant: **Demo Plant**

## Data source connectors

See `DATA_SOURCE_CONNECTORS.md` for JSON, Excel/CSV, MQTT, and external SQL connector setup.

## Tenant onboarding

See `TENANT_ONBOARDING.md` for module selection, page visibility, tag mapping, shift definitions, and EMS/WMS totalizer calculations per tenant.

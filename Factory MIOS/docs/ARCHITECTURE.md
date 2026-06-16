# Architecture

## Overview
Factory MIOS is a containerized, multi-tenant SaaS. Each customer is a **tenant**;
every business row carries `tenant_id` and the API scopes all queries to the caller's
tenant. Telemetry is stored in a TimescaleDB hypertable for time-series performance.

```
 Devices ──MQTT──►  Mosquitto ──► mqtt_ingestor ─┐
 Devices ──HTTPS─►  FastAPI /ingest/http ────────┼──► TimescaleDB (telemetry hypertable)
 Files   ──CSV──►   FastAPI /ingest/csv ─────────┘
                                                  │
 Next.js frontend ◄── REST /api/v1 ◄── FastAPI ◄──┘ (auth, onboarding, KPI engine,
                                                      master data, shifts, dashboards,
                                                      AI assistant)
```

## Backend (FastAPI)
- `app/core` — config (pydantic-settings), DB engine/session, security (JWT, bcrypt).
- `app/models/models.py` — Tenant, User, OnboardingLink, Client, Device, Telemetry,
  MasterData, Shift, KPIDefinition, Dashboard.
- `app/api/routes` — auth, onboarding, devices, ingest, masterdata, kpi, shifts,
  dashboards, chatbot. `deps.py` enforces auth + role + tenant scoping.
- `app/services/kpi_engine.py` — resolves inputs (telemetry aggregations, master-data
  fields, constants) and safely evaluates the expression with `simpleeval`.
- `app/services/catalog.py` — widget types, industries/machine types, dashboard templates.
- `app/services/mqtt_ingestor.py` — standalone MQTT subscriber.

## KPI/formula engine
A KPI is `expression` + `inputs`. Inputs map a variable name to a source:
`telemetry` (parameter + aggregation + optional window), `master` (dataset/key/field),
or `const`. The expression is evaluated with no builtins or attribute access, so
user formulas cannot run arbitrary code. This is the "connect parameters like wires
with a math operator" model, evaluated against the latest telemetry, shift context,
totalizers/aggregates, and master data.

## Frontend (Next.js, app router)
Public brief (`/`), onboarding (`/onboard/[linkId]`), login, dashboards
(template-driven widget grid using Recharts), KPI builder, onboarding-link manager,
and a floating AI assistant. `lib/api.ts` wraps the REST API and holds the JWT.

## Multi-tenancy & roles
Roles: `platform_admin`, `tenant_admin`, `engineer`, `viewer`. `platform_admin`
manages the platform and can mint onboarding links; `tenant_admin`/`engineer` manage
their tenant's devices, master data, KPIs and dashboards; `viewer` is read-only.

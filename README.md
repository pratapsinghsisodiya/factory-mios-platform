# Factory-MIOS Platform (new SaaS workspace)

**Factory-MIOS** = **Factory Manufacturing Intelligent Operating System**

This folder is a **separate copy** for new SaaS development. It does **not** replace or modify your existing Docker stack.

## Two environments (keep both)

| | Existing (do not change) | This project (new work) |
|---|---|---|
| **Docker project** | `factory-mios` | `factory-mios-platform` |
| **Folder** | `OneDrive\...\oee-dashboard-app\saas-docker-app` | `Documents\GitHub\factory-mios-platform` |
| **Gateway** | `http://localhost:8080` | `http://localhost:8090` |
| **PostgreSQL** | `localhost:5432` | `localhost:5433` |
| **Git branch source** | local working copy | `origin/cursor/docker-saas-foundation-0a15` |

## Product names

| Name | Role |
|------|------|
| **Factory-MIOS** | SaaS product / platform |
| **Z-OT Agent** | Rule-based OEE intelligence (Hinglish NLP) |
| **Facto-Bot / Z-BoT** | Gemini/Claude AI SQL assistant |

## Quick start

```powershell
cd "C:\Users\singh\Documents\GitHub\factory-mios-platform"
docker compose up -d --build
```

Open **http://localhost:8090** → welcome/setup wizard on first run.

## GitHub

Source branch: [cursor/docker-saas-foundation-0a15](https://github.com/pratapsinghsisodiya/oee-dashboard/tree/cursor/docker-saas-foundation-0a15)

Suggested new repo name: **`factory-mios-platform`**

## Docs in this folder

- `FACTORY_MIOS_PRODUCT_BLUEPRINT.md` — product roadmap
- `LOCAL_DOCKER_QUICKSTART.md` — Docker setup
- `TENANT_ONBOARDING.md` — tenant/plant/device flow
- `DATA_SOURCE_CONNECTORS.md` — MQTT, JSON, CSV, SQL connectors

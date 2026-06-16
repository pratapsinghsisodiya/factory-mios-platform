# How to test Factory MIOS

Prerequisite: **Docker Desktop** installed and running.

## 1. Start everything (with demo data)
Open a terminal in the project folder and run:

```bash
cp .env.example .env          # first time only; then edit SECRET_KEY/passwords
docker compose --profile demo up --build
```

Wait until you see `mios-backend` logging `Uvicorn running` and
`mios-frontend` ready. First build takes a few minutes.

## 2. Quick health checks (no login)
- API health:  http://localhost:8000/health  → `{"status":"ok",...}`
- API docs:    http://localhost:8000/docs     → full Swagger list of 29 endpoints
- Product brief: http://localhost:3000         → landing page loads

## 3. Sign in
Go to http://localhost:3000/login

```
email:    demo@factory-mios.local
password: Demo!2026
```

## 4. Feature checklist
| What to test | Where | Expected result |
|---|---|---|
| **Dashboards** | /dashboard | Catalog counts shown; pick a template + "Create" makes a dashboard with widgets |
| **Live data** | /dashboard (after demo simulator runs ~30s) | Bound KPI widgets show changing values; refreshes every 10s |
| **Drag-and-drop builder** | /builder | Drag widgets from the left palette onto the canvas, rename, reorder, bind a KPI, "Save dashboard" |
| **Excel export** | /dashboard → "oee .xlsx" etc. | Downloads an .xlsx that opens in Excel with a summary + chart + telemetry sheet |
| **KPI builder** | /kpi-builder | Create `good/total*100`, map inputs, Save; appears in list |
| **Onboarding link** | /clients | "Generate link", copy it, open in a new private window → registration form → creates a workspace |
| **AI assistant** | bottom-right "Ask AI" | Ask "how do I connect a device?" → returns guidance |

## 5. See live demo data (the simulator)
If you started with `--profile demo`, the simulator is already writing telemetry.
Create an OEE dashboard, then in the builder bind a "Single Stat" or "Gauge"
widget to a KPI you made in /kpi-builder (e.g. quality = good_count / total_count * 100).
Values update on the dashboard every 10s.

## 6. Test a real device feed over HTTPS (optional, no MQTT)
Create a device in the API docs (`POST /api/v1/devices`) to get its `api_key`, then:

```bash
curl -X POST http://localhost:8000/api/v1/ingest/http \
  -H "X-API-Key: <device_api_key>" -H "Content-Type: application/json" \
  -d '{"points":[{"parameter":"good_count","value":480},{"parameter":"total_count","value":500}]}'
```

## 7. Stop
```bash
docker compose --profile demo down          # keeps data
docker compose --profile demo down -v       # also wipes the database
```

## Troubleshooting
- Port already in use → edit the `*_PORT` values in `.env`.
- Frontend can't reach API → confirm `NEXT_PUBLIC_API_URL=http://localhost:8000` in `.env`.
- Backend won't start → check `docker compose logs backend`.

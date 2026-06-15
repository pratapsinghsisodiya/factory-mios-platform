# Factory-MIOS data source connectors

Factory-MIOS dashboards should not be limited to only the internal TimescaleDB database. This connector foundation lets an admin register and preview external data sources that dashboard widgets can use.

## Supported source types

| Type | Purpose | Example |
| --- | --- | --- |
| `json_url` | HTTP/HTTPS API returning JSON | REST endpoint, cloud API, local gateway API |
| `json_file` | JSON file dropped into imports volume | `imports/sample.json` |
| `excel_file` | Excel `.xlsx` or CSV file dropped into imports volume | exported production report |
| `postgres` | External PostgreSQL/TimescaleDB read-only SQL | customer DB, reporting DB |
| `mqtt` | MQTT broker/topic one-message preview | machine or IoT gateway topic |

## Runtime storage

Connector definitions are tenant-scoped and stored in:

```text
config/data_sources.json
```

Imported files go into:

```text
imports/
```

In Docker this is backed by the `data_imports` volume and mounted at:

```text
/app/imports
```

## API endpoints

All endpoints require login. Creating/deleting sources requires admin-style roles: `superadmin`, `admin`, or `plant_admin`.

```http
GET    /api/data-sources/types
GET    /api/data-sources
POST   /api/data-sources
POST   /api/data-sources/preview
POST   /api/data-sources/:id/preview
DELETE /api/data-sources/:id
```

## Register a JSON URL source

```bash
curl -X POST http://localhost:8080/api/data-sources \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "erp-orders",
    "name": "ERP Orders",
    "type": "json_url",
    "url": "https://example.com/api/orders"
  }'
```

Preview:

```bash
curl -X POST http://localhost:8080/api/data-sources/erp-orders/preview \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Register a JSON file source

Copy a file into the Docker volume or local `imports/` folder:

```text
imports/sample-production.json
```

Then register:

```json
{
  "id": "sample-production-json",
  "name": "Sample Production JSON",
  "type": "json_file",
  "file": "sample-production.json"
}
```

The JSON can be an array or an object containing `rows`, `data`, `items`, `readings`, `records`, or `result`.

## Register an Excel or CSV source

Put a file under `imports/`, for example:

```text
imports/shift-report.xlsx
imports/quality-export.csv
```

Register Excel:

```json
{
  "id": "shift-report-excel",
  "name": "Shift Report Excel",
  "type": "excel_file",
  "file": "shift-report.xlsx",
  "sheet": "Sheet1",
  "headerRow": 1
}
```

Register CSV:

```json
{
  "id": "quality-csv",
  "name": "Quality CSV",
  "type": "excel_file",
  "file": "quality-export.csv"
}
```

## Register an external SQL source

Only `SELECT` queries are allowed by the connector preview layer.

```json
{
  "id": "external-oee",
  "name": "External OEE DB",
  "type": "postgres",
  "connectionString": "postgresql://readonly_user:password@host:5432/reporting_db",
  "query": "SELECT machine_id, shift_date, oee FROM oee_results WHERE shift_date >= CURRENT_DATE - INTERVAL '7 days'",
  "limit": 100
}
```

For production SaaS, use a read-only DB user and tenant-specific views.

## Register an MQTT source

The current preview connects to the broker, subscribes to a topic, and waits for one message. If the message is JSON, it is parsed as rows; otherwise the raw payload is returned.

```json
{
  "id": "machine-live-mqtt",
  "name": "Machine Live MQTT",
  "type": "mqtt",
  "brokerUrl": "mqtt://host.docker.internal:1883",
  "topic": "factory/machine001/live",
  "clientId": "factory-mios-preview"
}
```

## Dashboard integration plan

Current implementation provides the connector registry and preview API. Next dashboard-builder step:

1. Add a data-source selector to widget configuration.
2. Store `source_id`, field mapping, aggregation, and refresh interval per widget.
3. Add a widget data API that reads from registered source IDs.
4. Cache external source results to avoid slow dashboards.
5. Enforce tenant-specific connector ownership.

## Caching and field mapping

The backend returns field metadata with every preview/data response. Dashboard widgets store mappings such as:

```json
{
  "source_id": "quality-csv",
  "widget_kind": "kpi",
  "valueField": "rejected_parts",
  "labelField": "shift",
  "timeField": "time"
}
```

External connector reads are cached in memory for the source cache TTL. Configure with:

```env
DATA_SOURCE_CACHE_TTL_MS=30000
```

Use `refresh=1` on the data endpoint to bypass cache:

```http
GET /api/data-sources/:id/data?refresh=1
```

## Tenant scoping and encrypted secrets

Sources are saved with a `tenant_id`. Superadmins can see all sources; other users only see sources for their tenant. Sensitive connector values such as connection strings, passwords, tokens, and authorization headers are encrypted at rest using AES-256-GCM. Set a stable secret in production:

```env
DATA_CONNECTOR_SECRET=replace_with_long_random_secret
```

If this value changes, existing encrypted connector secrets cannot be decrypted.

## Important SaaS security notes

Before this is production SaaS:

- encrypt connector secrets at rest
- scope connectors by tenant
- restrict external SQL to read-only users and allowlisted views
- add query timeouts and result limits everywhere
- audit every connector create/update/delete
- rate-limit connector previews
- do not expose connector secrets back to browsers

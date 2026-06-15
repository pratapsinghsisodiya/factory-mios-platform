# Factory-MIOS tenant onboarding

Factory-MIOS tenant onboarding defines what a client can see and how their plant data is interpreted.

During onboarding, a superadmin/admin should configure:

1. Tenant/company identity
2. Enabled MIOS modules
3. Visible pages per tenant
4. Plants and machines
5. Tags/signals coming from PLC, MQTT, JSON, Excel, SQL, or APIs
6. Shift schedule
7. Shift calculations such as kWh and water totalizer consumption
8. Initial dashboards and KPIs
9. Initial tenant admin / tenant users

## Predefined modules

The backend provides predefined module templates from:

```text
lib/factory-mios-onboarding.js
```

Available modules:

| Module key | Purpose |
| --- | --- |
| `realtime_monitoring` | Live status, alarms, counters, runtime |
| `production_oee` | OEE, availability, performance, quality, targets |
| `ems` | Energy Management System: kWh, kW, PF, demand |
| `wms` | Water Management System: flow, totalizer, pressure, quality |
| `utilities` | Air, gas, steam, chillers, utility systems |
| `quality` | Quality and rejection tracking |
| `downtime` | Downtime and RCA tracking |

## API endpoints

```http
GET  /api/factory-mios/module-templates
POST /api/factory-mios/onboarding/preview
POST /api/factory-mios/onboarding/apply
```

All require login. Applying onboarding requires admin/superadmin style roles.

## Example onboarding payload

```json
{
  "tenant": {
    "id": "acme-auto",
    "name": "ACME Auto Components",
    "slug": "acme-auto"
  },
  "modules": [
    "realtime_monitoring",
    "production_oee",
    "ems",
    "wms",
    "utilities"
  ],
  "pages": [
    "dashboard",
    "machine-live",
    "reports",
    "alerts"
  ],
  "shifts": [
    { "name": "Shift A", "label": "Day", "start": "07:00", "end": "19:00", "planned_min": 720, "break_min": 45 },
    { "name": "Shift B", "label": "Night", "start": "19:00", "end": "07:00", "planned_min": 720, "break_min": 45 }
  ],
  "tags": [
    {
      "key": "main_incomer_kwh",
      "label": "Main Incomer kWh",
      "type": "counter",
      "unit": "kWh",
      "category": "energy",
      "device_id": "EM_MAIN",
      "source_field": "kwh_total",
      "tag_path": "factory/plant1/energy/main/kwh"
    },
    {
      "key": "water_totalizer_line1",
      "label": "Line 1 Water Totalizer",
      "type": "counter",
      "unit": "m3",
      "category": "water",
      "device_id": "WFM_LINE1",
      "source_field": "water_totalizer",
      "tag_path": "factory/plant1/water/line1/totalizer"
    }
  ],
  "shift_calculations": [
    {
      "key": "line1_water_shift",
      "label": "Line 1 Shift Water Consumption",
      "method": "delta_counter",
      "unit": "m3",
      "config": { "field": "water_totalizer_line1" }
    },
    {
      "key": "main_kwh_shift",
      "label": "Main Shift kWh Consumption",
      "method": "delta_counter",
      "unit": "kWh",
      "config": { "field": "main_incomer_kwh" }
    }
  ]
}
```

## Preview before applying

```bash
curl -X POST http://localhost:8080/api/factory-mios/onboarding/preview \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d @onboarding.json
```

Preview returns the resolved pages, tags, shifts, calculations, and dashboards.

## Apply onboarding

```bash
curl -X POST http://localhost:8080/api/factory-mios/onboarding/apply \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d @onboarding.json
```

Apply writes/updates:

```text
config/tenant_module_assignments.json
config/kpi_config.json
config/published-dashboards.json
```

## What apply creates

1. Tenant module assignment
   - enabled modules
   - enabled page keys
   - tags
   - shift definitions
   - shift calculations

2. Initial KPIs
   - one KPI per tag template/custom tag
   - aggregation defaults based on tag type

3. Initial dashboards
   - EMS dashboard
   - WMS dashboard
   - utilities dashboard
   - production OEE dashboard
   - real-time monitoring dashboard

## EMS shift kWh logic

For energy totalizer tags, shift consumption should be:

```text
shift_kwh = max(kwh_total within shift) - min(kwh_total within shift)
```

Factory-MIOS stores this as:

```json
{
  "method": "delta_counter",
  "unit": "kWh",
  "config": { "field": "kwh_total" }
}
```

## WMS shift water logic

For water totalizer tags, shift consumption should be:

```text
shift_water = max(water_totalizer within shift) - min(water_totalizer within shift)
```

Factory-MIOS stores this as:

```json
{
  "method": "delta_counter",
  "unit": "m3",
  "config": { "field": "water_totalizer" }
}
```

## Page visibility

The onboarding config stores enabled pages per tenant. The existing SaaS permission tables/API are still present. Next production step is to fully enforce page/module visibility server-side and in every menu/API.

## Tenant users

The payload can include initial user metadata, but production SaaS still needs DB-backed users and invite/password flows. Current JSON user storage is not enough for real SaaS.

## Next UI work

A superadmin onboarding wizard should be added on top of these APIs:

1. Create tenant
2. Choose modules
3. Choose pages
4. Add plant and shifts
5. Map tags/signals
6. Select predefined dashboards
7. Create tenant admin user
8. Review and apply

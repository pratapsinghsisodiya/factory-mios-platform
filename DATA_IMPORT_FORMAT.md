# Factory-MIOS CSV / Excel import format

Data is stored per **plant** (PostgreSQL schema) and **machine** (table). Each measurement is a row with `point_key` (same names as your data point tags).

## Long format (recommended)

| time | point_key | value_num | value_text | unit |
|------|-----------|-----------|------------|------|
| 2026-06-04T10:00:00Z | parts_count | 120 | | parts |
| 2026-06-04T10:00:00Z | is_running | 1 | | |
| 2026-06-04T10:00:05Z | kwh_total | 4521.5 | | kWh |

- **time** — ISO-8601 or Excel date (required)
- **point_key** — tag name, lowercase with underscores (required)
- **value_num** — numeric value (preferred)
- **value_text** — text/boolean/status (optional)
- **unit** — optional

## Wide format

| time | parts_count | is_running | kwh_total |
|------|-------------|------------|-----------|
| 2026-06-04T10:00:00Z | 120 | 1 | 4521.5 |

First column must be `time`, `timestamp`, `ts`, or `datetime`. Other columns are exploded into `point_key` rows on import.

## MQTT / HTTPS live JSON

```json
{
  "time": "2026-06-04T10:00:00Z",
  "points": {
    "parts_count": 120,
    "is_running": 1,
    "kwh_total": 4521.5
  }
}
```

POST to: `/api/ingest/v1/{plant_id}/{machine_id}` with header `X-Ingest-Key`.

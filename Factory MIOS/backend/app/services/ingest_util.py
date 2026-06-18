"""Normalize incoming telemetry payloads into (parameter, value, value_text) rows.

Adopted from the Factory-MIOS gateway convention so real machine payloads work:

  flat JSON:   {"machine_state": "RUNNING", "spindle_speed": 1200, "timestamp": "..."}
  points map:  {"points": {"part_count": 480, "cycle_time": 29.5}, "ts": "..."}
  points list: {"points": [{"parameter": "part_count", "value": 480}]}

Reserved time keys (timestamp/time/ts) are pulled out as the row timestamp.
Numeric strings become numeric values; non-numeric strings (e.g. machine_state)
are stored as text. Each key should match a telemetry-definition raw_name.
"""
from datetime import datetime, timezone

_TIME_KEYS = ("timestamp", "time", "ts")


def _coerce(v):
    if isinstance(v, bool):
        return (1.0 if v else 0.0, None)
    if isinstance(v, (int, float)):
        return (float(v), None)
    if isinstance(v, str):
        try:
            return (float(v), None)
        except ValueError:
            return (None, v)
    return (None, None)


def parse_ts(raw) -> datetime:
    if not raw:
        return datetime.now(timezone.utc)
    if isinstance(raw, (int, float)):
        # epoch seconds or ms
        sec = raw / 1000.0 if raw > 1e11 else raw
        try:
            return datetime.fromtimestamp(sec, tz=timezone.utc)
        except Exception:  # noqa: BLE001
            return datetime.now(timezone.utc)
    try:
        s = str(raw).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:  # noqa: BLE001
        return datetime.now(timezone.utc)


def normalize(payload: dict):
    """Returns (rows, ts) where rows is a list of (parameter, value, value_text)."""
    if not isinstance(payload, dict):
        return [], datetime.now(timezone.utc)
    ts = parse_ts(next((payload.get(k) for k in _TIME_KEYS if payload.get(k)), None))

    pts = payload.get("points")
    rows = []
    if isinstance(pts, list):
        for p in pts:
            if isinstance(p, dict) and p.get("parameter"):
                val, txt = _coerce(p.get("value")) if p.get("value") is not None else (None, p.get("value_text"))
                rows.append((str(p["parameter"]), val, txt or p.get("value_text")))
        return rows, ts

    src = pts if isinstance(pts, dict) else payload
    for k, v in src.items():
        if k in _TIME_KEYS or k == "points":
            continue
        val, txt = _coerce(v)
        if val is None and txt is None:
            continue
        rows.append((str(k), val, txt))
    return rows, ts

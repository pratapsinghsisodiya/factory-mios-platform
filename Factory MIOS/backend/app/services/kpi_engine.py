"""Safe KPI computation engine.

A KPIDefinition has an `expression` (e.g. "good/total*100") and `inputs`,
a mapping of variable name -> resolution spec:

    {"good":  {"source": "telemetry", "parameter": "good_count", "agg": "last"},
     "total": {"source": "telemetry", "parameter": "total_count", "agg": "last"},
     "ct":    {"source": "master", "dataset": "parts", "key": "P-100", "field": "target_cycle_time"},
     "const": {"source": "const", "value": 3600}}

Supported telemetry aggregations within an optional time window:
    last, first, sum, avg, min, max, count, delta (max-min).
Expressions are evaluated with simpleeval — no builtins, no attribute access,
so user-authored formulas cannot execute arbitrary code.
"""
from datetime import datetime, timedelta, timezone
from sqlalchemy import func
from sqlalchemy.orm import Session
from simpleeval import SimpleEval, DEFAULT_FUNCTIONS
from app.models.models import Telemetry, MasterData, KPIDefinition

_AGG = {
    "last": lambda q: q.order_by(Telemetry.ts.desc()).limit(1),
    "first": lambda q: q.order_by(Telemetry.ts.asc()).limit(1),
}


def _window(q, device_id, window_minutes):
    if device_id:
        q = q.filter(Telemetry.device_id == device_id)
    if window_minutes:
        since = datetime.now(timezone.utc) - timedelta(minutes=window_minutes)
        q = q.filter(Telemetry.ts >= since)
    return q


def _resolve_telemetry(db: Session, tenant_id, spec, device_id, window_minutes):
    base = db.query(Telemetry).filter(
        Telemetry.tenant_id == tenant_id,
        Telemetry.parameter == spec["parameter"],
    )
    dev = spec.get("device_id", device_id)
    base = _window(base, dev, spec.get("window_minutes", window_minutes))
    agg = spec.get("agg", "last")
    if agg in ("last", "first"):
        row = _AGG[agg](base).first()
        return float(row.value) if row and row.value is not None else None
    col = Telemetry.value
    func_map = {
        "sum": func.sum(col), "avg": func.avg(col), "min": func.min(col),
        "max": func.max(col), "count": func.count(col),
    }
    if agg == "delta":
        hi = base.with_entities(func.max(col)).scalar()
        lo = base.with_entities(func.min(col)).scalar()
        return float(hi - lo) if hi is not None and lo is not None else None
    if agg in func_map:
        val = base.with_entities(func_map[agg]).scalar()
        return float(val) if val is not None else None
    raise ValueError(f"Unknown aggregation '{agg}'")


def _resolve_master(db: Session, tenant_id, spec):
    row = db.query(MasterData).filter(
        MasterData.tenant_id == tenant_id,
        MasterData.dataset == spec["dataset"],
        MasterData.key == spec["key"],
    ).first()
    if not row:
        return None
    val = (row.attributes or {}).get(spec["field"])
    try:
        return float(val)
    except (TypeError, ValueError):
        return val


def resolve_inputs(db: Session, tenant_id: str, inputs: dict,
                   device_id: str | None = None, window_minutes: int | None = None) -> dict:
    resolved = {}
    for var, spec in (inputs or {}).items():
        src = spec.get("source")
        if src == "telemetry":
            resolved[var] = _resolve_telemetry(db, tenant_id, spec, device_id, window_minutes)
        elif src == "master":
            resolved[var] = _resolve_master(db, tenant_id, spec)
        elif src == "const":
            resolved[var] = spec.get("value")
        else:
            resolved[var] = None
    return resolved


def evaluate(expression: str, names: dict):
    safe_names = {k: (v if v is not None else 0) for k, v in names.items()}
    evaluator = SimpleEval(functions=DEFAULT_FUNCTIONS, names=safe_names)
    return evaluator.eval(expression)


def compute_kpi(db: Session, kpi: KPIDefinition, device_id: str | None = None,
                window_minutes: int | None = None):
    resolved = resolve_inputs(db, kpi.tenant_id, kpi.inputs, device_id, window_minutes)
    try:
        value = evaluate(kpi.expression, resolved)
        return {"value": float(value), "inputs_resolved": resolved, "error": None}
    except Exception as e:  # noqa: BLE001 - surface formula errors to the user
        return {"value": None, "inputs_resolved": resolved, "error": str(e)}

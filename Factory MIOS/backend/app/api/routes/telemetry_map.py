"""Telemetry parameter mapping + live-test page backing endpoints."""
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from app.api.deps import DbDep, CurrentUser, tenant_scope, require_roles
from app.models.models import TelemetryDefinition, Telemetry, Device

router = APIRouter(prefix="/telemetry-map", tags=["telemetry-mapping"])


class DefIn(BaseModel):
    device_id: str
    raw_name: str
    display_name: str
    data_type: str = "numeric"
    unit: str | None = None
    aggregation: str = "last"
    usage: dict = {}
    ai_enabled: bool = True
    alarm_enabled: bool = False
    color_rules: dict = {}


@router.get("")
def list_defs(db: DbDep, user: CurrentUser, device_id: str | None = None):
    tid = tenant_scope(user)
    q = db.query(TelemetryDefinition).filter(TelemetryDefinition.tenant_id == tid)
    if device_id:
        q = q.filter(TelemetryDefinition.device_id == device_id)
    return [{c.name: getattr(r, c.name) for c in TelemetryDefinition.__table__.columns} for r in q.all()]


@router.post("", dependencies=[Depends(require_roles("tenant_admin", "engineer", "plant_admin"))])
def upsert_def(body: DefIn, db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    existing = db.query(TelemetryDefinition).filter(
        TelemetryDefinition.tenant_id == tid, TelemetryDefinition.device_id == body.device_id,
        TelemetryDefinition.raw_name == body.raw_name).first()
    if existing:
        for k, v in body.model_dump().items():
            setattr(existing, k, v)
        existing.tenant_id = tid
    else:
        existing = TelemetryDefinition(tenant_id=tid, **body.model_dump())
        db.add(existing)
    db.commit(); db.refresh(existing)
    return {"id": existing.id, "raw_name": existing.raw_name}


@router.get("/live-test/{device_id}")
def live_test(device_id: str, db: DbDep, user: CurrentUser):
    """Diagnostics for the live-test page: connectivity + latest payload + mapping coverage."""
    tid = tenant_scope(user)
    dev = db.query(Device).filter(Device.id == device_id, Device.tenant_id == tid).first()
    if not dev:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Device not found")

    since = datetime.now(timezone.utc) - timedelta(minutes=10)
    recent = (db.query(Telemetry).filter(Telemetry.tenant_id == tid, Telemetry.device_id == device_id,
              Telemetry.ts >= since).order_by(Telemetry.ts.desc()).limit(50).all())
    latest_by_param: dict[str, dict] = {}
    for t in recent:
        if t.parameter not in latest_by_param:
            latest_by_param[t.parameter] = {"value": t.value, "ts": t.ts.isoformat()}

    defs = db.query(TelemetryDefinition).filter(TelemetryDefinition.tenant_id == tid,
                                                TelemetryDefinition.device_id == device_id).all()
    mapped = {d.raw_name for d in defs}
    incoming = set(latest_by_param)
    last_seen = dev.last_seen.isoformat() if dev.last_seen else None
    if not incoming:
        conn_status = "no_data"
    elif dev.last_seen and dev.last_seen > since:
        conn_status = "data_received"
    else:
        conn_status = "stale"
    return {
        "device": dev.name,
        "status": conn_status,
        "last_seen": last_seen,
        "latest_payload": latest_by_param,
        "mapped_parameters": sorted(mapped),
        "unmapped_parameters": sorted(incoming - mapped),
        "missing_mapped": sorted(mapped - incoming),
    }

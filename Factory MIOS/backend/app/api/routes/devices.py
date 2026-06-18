from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from app.api.deps import DbDep, CurrentUser, tenant_scope, require_roles
from app.models.models import Device, Client
from app.schemas.schemas import DeviceCreate, DeviceOut

router = APIRouter(prefix="/devices", tags=["devices"])


@router.post("", response_model=DeviceOut,
             dependencies=[Depends(require_roles("tenant_admin", "engineer"))])
def create_device(body: DeviceCreate, db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    if body.connection_type not in ("mqtt", "https", "csv"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "connection_type must be mqtt|https|csv")
    if body.client_id:
        client = db.query(Client).filter(Client.id == body.client_id, Client.tenant_id == tid).first()
        if not client:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Client not found in tenant")
    dev = Device(tenant_id=tid, **body.model_dump())
    db.add(dev)
    db.commit()
    db.refresh(dev)
    return dev


@router.get("", response_model=list[DeviceOut])
def list_devices(db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    return db.query(Device).filter(Device.tenant_id == tid).order_by(Device.created_at.desc()).all()


@router.get("/{device_id}", response_model=DeviceOut)
def get_device(device_id: str, db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    dev = db.query(Device).filter(Device.id == device_id, Device.tenant_id == tid).first()
    if not dev:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Device not found")
    return dev


@router.patch("/{device_id}/location", response_model=DeviceOut,
              dependencies=[Depends(require_roles("tenant_admin", "engineer"))])
def update_location(device_id: str, latitude: float, longitude: float, db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    dev = db.query(Device).filter(Device.id == device_id, Device.tenant_id == tid).first()
    if not dev:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Device not found")
    dev.latitude, dev.longitude = latitude, longitude
    db.commit()
    db.refresh(dev)
    return dev


# --- Per-device parameters & raw values (for KPI building and dashboards) ---
from datetime import datetime, timezone, timedelta  # noqa: E402
from sqlalchemy import func  # noqa: E402
from app.models.models import Telemetry, TelemetryDefinition  # noqa: E402


@router.get("/{device_id}/parameters")
def device_parameters(device_id: str, db: DbDep, user: CurrentUser):
    """Mapped definitions + any raw parameters seen in telemetry for this device."""
    tid = tenant_scope(user)
    dev = db.query(Device).filter(Device.id == device_id, Device.tenant_id == tid).first()
    if not dev:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Device not found")
    defs = db.query(TelemetryDefinition).filter(
        TelemetryDefinition.tenant_id == tid, TelemetryDefinition.device_id == device_id).all()
    seen = [r[0] for r in db.query(Telemetry.parameter).filter(
        Telemetry.tenant_id == tid, Telemetry.device_id == device_id).distinct().all()]
    mapped = {d.raw_name for d in defs}
    return {
        "mapped": [{"raw_name": d.raw_name, "display_name": d.display_name, "unit": d.unit,
                    "data_type": d.data_type, "aggregation": d.aggregation, "kpi_type": d.kpi_type}
                   for d in defs],
        "seen": sorted(seen),
        "unmapped": sorted(set(seen) - mapped),
    }


@router.get("/{device_id}/value")
def device_value(device_id: str, parameter: str, db: DbDep, user: CurrentUser,
                 agg: str = "last", window_minutes: int = 60):
    """Aggregate a single raw parameter for this device over a window."""
    tid = tenant_scope(user)
    since = datetime.now(timezone.utc) - timedelta(minutes=window_minutes)
    base = db.query(Telemetry).filter(
        Telemetry.tenant_id == tid, Telemetry.device_id == device_id,
        Telemetry.parameter == parameter, Telemetry.ts >= since)
    if agg == "last":
        row = base.order_by(Telemetry.ts.desc()).first()
        val = row.value if row else None
    elif agg == "first":
        row = base.order_by(Telemetry.ts.asc()).first()
        val = row.value if row else None
    elif agg == "delta":
        hi = base.with_entities(func.max(Telemetry.value)).scalar()
        lo = base.with_entities(func.min(Telemetry.value)).scalar()
        val = (hi - lo) if hi is not None and lo is not None else None
    else:
        fn = {"sum": func.sum, "avg": func.avg, "min": func.min, "max": func.max,
              "count": func.count}.get(agg, func.avg)
        val = base.with_entities(fn(Telemetry.value)).scalar()
    return {"parameter": parameter, "agg": agg, "value": float(val) if val is not None else None}

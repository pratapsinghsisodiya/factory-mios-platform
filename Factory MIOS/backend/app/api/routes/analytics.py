"""AI Analytics page backing: parameter selection, aggregation, comparison, trend."""
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import func
from app.api.deps import DbDep, CurrentUser, tenant_scope
from app.models.models import Telemetry

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("/parameters")
def parameters(db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    rows = db.query(Telemetry.parameter).filter(Telemetry.tenant_id == tid).distinct().all()
    return sorted({r[0] for r in rows})


class AggQuery(BaseModel):
    parameters: list[str]
    device_ids: list[str] = []
    hours: int = 24
    bucket_minutes: int = 60


@router.post("/aggregate")
def aggregate(body: AggQuery, db: DbDep, user: CurrentUser):
    """avg/min/max/sum/count per parameter over the window."""
    tid = tenant_scope(user)
    since = datetime.now(timezone.utc) - timedelta(hours=body.hours)
    out = []
    for p in body.parameters:
        q = db.query(func.avg(Telemetry.value), func.min(Telemetry.value), func.max(Telemetry.value),
                     func.sum(Telemetry.value), func.count(Telemetry.value)).filter(
            Telemetry.tenant_id == tid, Telemetry.parameter == p, Telemetry.ts >= since)
        if body.device_ids:
            q = q.filter(Telemetry.device_id.in_(body.device_ids))
        avg, mn, mx, sm, cnt = q.first()
        out.append({"parameter": p, "avg": _f(avg), "min": _f(mn), "max": _f(mx),
                    "sum": _f(sm), "count": int(cnt or 0)})
    return out


@router.post("/trend")
def trend(body: AggQuery, db: DbDep, user: CurrentUser):
    """Time-bucketed average series per parameter for charting."""
    tid = tenant_scope(user)
    since = datetime.now(timezone.utc) - timedelta(hours=body.hours)
    bucket = func.to_timestamp(
        func.floor(func.extract("epoch", Telemetry.ts) / (body.bucket_minutes * 60)) * (body.bucket_minutes * 60)
    )
    series = {}
    for p in body.parameters:
        q = db.query(bucket.label("b"), func.avg(Telemetry.value)).filter(
            Telemetry.tenant_id == tid, Telemetry.parameter == p, Telemetry.ts >= since)
        if body.device_ids:
            q = q.filter(Telemetry.device_id.in_(body.device_ids))
        rows = q.group_by("b").order_by("b").all()
        series[p] = [{"t": r[0].isoformat() if hasattr(r[0], "isoformat") else str(r[0]),
                      "v": _f(r[1])} for r in rows]
    return series


def _f(v):
    return round(float(v), 3) if v is not None else None

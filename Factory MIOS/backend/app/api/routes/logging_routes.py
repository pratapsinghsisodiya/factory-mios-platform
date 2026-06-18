"""Downtime and quality logging (manual user input)."""
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func
from app.api.deps import DbDep, CurrentUser, tenant_scope, require_roles
from app.models.models import DowntimeLog, QualityLog

router = APIRouter(prefix="/logs", tags=["logging"])
_writer = [Depends(require_roles("tenant_admin", "engineer", "supervisor", "operator", "quality_user", "plant_admin"))]


# ---------- Downtime ----------
class DowntimeIn(BaseModel):
    device_id: str | None = None
    shift_id: str | None = None
    start_time: datetime | None = None
    end_time: datetime | None = None
    category: str | None = "unplanned"
    reason: str | None = None
    operator: str | None = None
    remarks: str | None = None


@router.post("/downtime", dependencies=_writer)
def create_downtime(body: DowntimeIn, db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    start = body.start_time or datetime.now(timezone.utc)
    dur = None
    status_val = "open"
    if body.end_time:
        dur = round((body.end_time - start).total_seconds() / 60.0, 2)
        status_val = "closed"
    o = DowntimeLog(tenant_id=tid, device_id=body.device_id, shift_id=body.shift_id,
                    start_time=start, end_time=body.end_time, duration_min=dur,
                    category=body.category, reason=body.reason, operator=body.operator,
                    remarks=body.remarks, status=status_val)
    db.add(o); db.commit(); db.refresh(o)
    return {"id": o.id, "status": o.status, "duration_min": o.duration_min}


@router.patch("/downtime/{log_id}/close", dependencies=_writer)
def close_downtime(log_id: str, db: DbDep, user: CurrentUser, reason: str | None = None):
    tid = tenant_scope(user)
    o = db.query(DowntimeLog).filter(DowntimeLog.id == log_id, DowntimeLog.tenant_id == tid).first()
    if not o:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Downtime log not found")
    o.end_time = datetime.now(timezone.utc)
    o.duration_min = round((o.end_time - o.start_time).total_seconds() / 60.0, 2)
    if reason:
        o.reason = reason
    o.status = "closed"
    db.commit()
    return {"id": o.id, "duration_min": o.duration_min, "status": o.status}


@router.get("/downtime")
def list_downtime(db: DbDep, user: CurrentUser, device_id: str | None = None, days: int = 7):
    tid = tenant_scope(user)
    since = datetime.now(timezone.utc) - timedelta(days=days)
    q = db.query(DowntimeLog).filter(DowntimeLog.tenant_id == tid, DowntimeLog.start_time >= since)
    if device_id:
        q = q.filter(DowntimeLog.device_id == device_id)
    rows = q.order_by(DowntimeLog.start_time.desc()).all()
    return [{c.name: getattr(r, c.name) for c in DowntimeLog.__table__.columns} for r in rows]


@router.get("/downtime/pareto")
def downtime_pareto(db: DbDep, user: CurrentUser, days: int = 7):
    tid = tenant_scope(user)
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = (db.query(DowntimeLog.reason, func.sum(DowntimeLog.duration_min), func.count(DowntimeLog.id))
            .filter(DowntimeLog.tenant_id == tid, DowntimeLog.start_time >= since,
                    DowntimeLog.reason.isnot(None))
            .group_by(DowntimeLog.reason).order_by(func.sum(DowntimeLog.duration_min).desc()).all())
    return [{"reason": r[0], "total_minutes": float(r[1] or 0), "occurrences": int(r[2])} for r in rows]


# ---------- Quality ----------
class QualityIn(BaseModel):
    device_id: str | None = None
    shift_id: str | None = None
    logged_at: datetime | None = None
    product: str | None = None
    job_id: str | None = None
    batch_id: str | None = None
    serial_no: str | None = None
    good_qty: float = 0
    reject_qty: float = 0
    rework_qty: float = 0
    defect_reason: str | None = None
    operator: str | None = None
    remarks: str | None = None


@router.post("/quality", dependencies=_writer)
def create_quality(body: QualityIn, db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    data = body.model_dump()
    data["logged_at"] = body.logged_at or datetime.now(timezone.utc)
    o = QualityLog(tenant_id=tid, **data)
    db.add(o); db.commit(); db.refresh(o)
    return {"id": o.id}


@router.get("/quality")
def list_quality(db: DbDep, user: CurrentUser, device_id: str | None = None, days: int = 7):
    tid = tenant_scope(user)
    since = datetime.now(timezone.utc) - timedelta(days=days)
    q = db.query(QualityLog).filter(QualityLog.tenant_id == tid, QualityLog.logged_at >= since)
    if device_id:
        q = q.filter(QualityLog.device_id == device_id)
    rows = q.order_by(QualityLog.logged_at.desc()).all()
    return [{c.name: getattr(r, c.name) for c in QualityLog.__table__.columns} for r in rows]


@router.get("/quality/summary")
def quality_summary(db: DbDep, user: CurrentUser, days: int = 7):
    tid = tenant_scope(user)
    since = datetime.now(timezone.utc) - timedelta(days=days)
    g, rj, rw = db.query(func.sum(QualityLog.good_qty), func.sum(QualityLog.reject_qty),
                         func.sum(QualityLog.rework_qty)).filter(
        QualityLog.tenant_id == tid, QualityLog.logged_at >= since).first()
    g, rj, rw = float(g or 0), float(rj or 0), float(rw or 0)
    total = g + rj
    return {"good": g, "reject": rj, "rework": rw,
            "reject_rate_pct": round(rj / total * 100, 2) if total else 0,
            "fpy_pct": round(g / total * 100, 2) if total else 0}

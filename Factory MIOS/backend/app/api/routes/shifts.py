from fastapi import APIRouter, Depends
from app.api.deps import DbDep, CurrentUser, tenant_scope, require_roles
from app.models.models import Shift
from app.schemas.schemas import ShiftIn

router = APIRouter(prefix="/shifts", tags=["shifts"])


@router.post("", dependencies=[Depends(require_roles("tenant_admin", "engineer"))])
def create_shift(body: ShiftIn, db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    data = body.model_dump(exclude_none=True)
    shift = Shift(tenant_id=tid, **data)
    db.add(shift)
    db.commit()
    db.refresh(shift)
    return {"id": shift.id, "name": shift.name}


@router.get("")
def list_shifts(db: DbDep, user: CurrentUser, device_id: str | None = None):
    tid = tenant_scope(user)
    q = db.query(Shift).filter(Shift.tenant_id == tid)
    if device_id:
        q = q.filter(Shift.device_id == device_id)
    return [{"id": s.id, "name": s.name, "device_id": s.device_id, "start_time": s.start_time, "end_time": s.end_time,
             "target_production": s.target_production, "days": s.days}
            for s in q.all()]

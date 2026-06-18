from fastapi import APIRouter, Depends, HTTPException, status
from app.api.deps import DbDep, CurrentUser, tenant_scope, require_roles
from app.models.models import KPIDefinition
from app.schemas.schemas import KPIIn, KPIResult
from app.services.kpi_engine import compute_kpi, evaluate

router = APIRouter(prefix="/kpis", tags=["kpis"])


@router.post("", dependencies=[Depends(require_roles("tenant_admin", "engineer"))])
def create_kpi(body: KPIIn, db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    # validate the expression compiles against zeroed inputs before saving
    try:
        evaluate(body.expression, {k: 0 for k in body.inputs})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Invalid expression: {e}")
    kpi = KPIDefinition(tenant_id=tid, **body.model_dump())
    db.add(kpi)
    db.commit()
    db.refresh(kpi)
    return {"id": kpi.id, "name": kpi.name}


@router.get("")
def list_kpis(db: DbDep, user: CurrentUser, device_id: str | None = None):
    tid = tenant_scope(user)
    q = db.query(KPIDefinition).filter(KPIDefinition.tenant_id == tid)
    if device_id:
        q = q.filter(KPIDefinition.device_id == device_id)
    return [{"id": k.id, "name": k.name, "device_id": k.device_id, "unit": k.unit,
             "expression": k.expression, "inputs": k.inputs, "description": k.description}
            for k in q.all()]


@router.get("/{kpi_id}/compute", response_model=KPIResult)
def compute(kpi_id: str, db: DbDep, user: CurrentUser,
            device_id: str | None = None, window_minutes: int | None = None):
    tid = tenant_scope(user)
    kpi = db.query(KPIDefinition).filter(KPIDefinition.id == kpi_id,
                                         KPIDefinition.tenant_id == tid).first()
    if not kpi:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "KPI not found")
    res = compute_kpi(db, kpi, device_id, window_minutes)
    return KPIResult(name=kpi.name, unit=kpi.unit, **res)

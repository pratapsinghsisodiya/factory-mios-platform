import io
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
from app.api.deps import DbDep, CurrentUser, tenant_scope, require_roles
from app.models.models import MasterData
from app.schemas.schemas import MasterRow

router = APIRouter(prefix="/master-data", tags=["master-data"])


@router.get("")
def list_master(db: DbDep, user: CurrentUser, dataset: str | None = None):
    tid = tenant_scope(user)
    q = db.query(MasterData).filter(MasterData.tenant_id == tid)
    if dataset:
        q = q.filter(MasterData.dataset == dataset)
    return [{"id": m.id, "dataset": m.dataset, "key": m.key, "attributes": m.attributes}
            for m in q.order_by(MasterData.dataset, MasterData.key).all()]


@router.post("", dependencies=[Depends(require_roles("tenant_admin", "engineer"))])
def upsert_master(row: MasterRow, db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    existing = db.query(MasterData).filter(
        MasterData.tenant_id == tid, MasterData.dataset == row.dataset, MasterData.key == row.key
    ).first()
    if existing:
        existing.attributes = row.attributes
    else:
        existing = MasterData(tenant_id=tid, dataset=row.dataset, key=row.key, attributes=row.attributes)
        db.add(existing)
    db.commit()
    db.refresh(existing)
    return {"id": existing.id, "dataset": existing.dataset, "key": existing.key}


@router.post("/import", dependencies=[Depends(require_roles("tenant_admin", "engineer"))])
async def import_master(db: DbDep, user: CurrentUser, dataset: str, key_column: str,
                        file: UploadFile = File(...)):
    """Import a CSV/Excel master sheet. `key_column` identifies the row key;
    every other column becomes an attribute."""
    tid = tenant_scope(user)
    raw = await file.read()
    name = (file.filename or "").lower()
    df = pd.read_excel(io.BytesIO(raw)) if name.endswith((".xlsx", ".xls")) else pd.read_csv(io.BytesIO(raw))
    df.columns = [str(c).strip() for c in df.columns]
    if key_column not in df.columns:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"key_column '{key_column}' not in file")
    count = 0
    for _, r in df.iterrows():
        key = str(r[key_column])
        attrs = {c: (None if pd.isna(r[c]) else r[c]) for c in df.columns if c != key_column}
        attrs = {k: (float(v) if isinstance(v, (int, float)) else v) for k, v in attrs.items()}
        existing = db.query(MasterData).filter(
            MasterData.tenant_id == tid, MasterData.dataset == dataset, MasterData.key == key
        ).first()
        if existing:
            existing.attributes = attrs
        else:
            db.add(MasterData(tenant_id=tid, dataset=dataset, key=key, attributes=attrs))
        count += 1
    db.commit()
    return {"imported": count, "dataset": dataset}

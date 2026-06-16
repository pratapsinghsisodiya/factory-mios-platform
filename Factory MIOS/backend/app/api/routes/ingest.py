import io
from datetime import datetime, timezone
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, status, Header, UploadFile, File
from app.api.deps import DbDep, CurrentUser, tenant_scope
from app.models.models import Device, Telemetry
from app.schemas.schemas import IngestBatch

router = APIRouter(prefix="/ingest", tags=["ingestion"])


def _auth_device(db, api_key: str) -> Device:
    dev = db.query(Device).filter(Device.api_key == api_key).first()
    if not dev:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid device API key")
    return dev


def _mark_seen(db, dev: Device):
    dev.status = "online"
    dev.last_seen = datetime.now(timezone.utc)


@router.post("/http")
def ingest_http(batch: IngestBatch, db: DbDep, x_api_key: str = Header(...)):
    """Device pushes telemetry over HTTPS, authenticated by its API key."""
    dev = _auth_device(db, x_api_key)
    rows = [
        Telemetry(tenant_id=dev.tenant_id, device_id=dev.id, parameter=p.parameter,
                  value=p.value, value_text=p.value_text,
                  ts=p.ts or datetime.now(timezone.utc))
        for p in batch.points
    ]
    db.add_all(rows)
    _mark_seen(db, dev)
    db.commit()
    return {"ingested": len(rows), "device": dev.name}


@router.post("/csv")
async def ingest_csv(db: DbDep, user: CurrentUser, device_id: str,
                     file: UploadFile = File(...)):
    """Upload a CSV/Excel export. Expected columns: parameter,value[,ts] OR a
    wide format with a timestamp column and one column per parameter."""
    tid = tenant_scope(user)
    dev = db.query(Device).filter(Device.id == device_id, Device.tenant_id == tid).first()
    if not dev:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Device not found")
    raw = await file.read()
    name = (file.filename or "").lower()
    try:
        if name.endswith((".xlsx", ".xls")):
            df = pd.read_excel(io.BytesIO(raw))
        else:
            df = pd.read_csv(io.BytesIO(raw))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Could not parse file: {e}")

    df.columns = [str(c).strip().lower() for c in df.columns]
    rows: list[Telemetry] = []
    if {"parameter", "value"}.issubset(df.columns):  # long format
        for _, r in df.iterrows():
            ts = pd.to_datetime(r["ts"]).to_pydatetime() if "ts" in df.columns and pd.notna(r.get("ts")) \
                else datetime.now(timezone.utc)
            rows.append(Telemetry(tenant_id=tid, device_id=dev.id, parameter=str(r["parameter"]),
                                  value=_num(r["value"]), ts=ts))
    else:  # wide format
        ts_col = next((c for c in df.columns if c in ("ts", "timestamp", "time", "datetime")), None)
        param_cols = [c for c in df.columns if c != ts_col]
        for _, r in df.iterrows():
            ts = pd.to_datetime(r[ts_col]).to_pydatetime() if ts_col and pd.notna(r.get(ts_col)) \
                else datetime.now(timezone.utc)
            for c in param_cols:
                rows.append(Telemetry(tenant_id=tid, device_id=dev.id, parameter=c,
                                      value=_num(r[c]), ts=ts))
    db.add_all(rows)
    _mark_seen(db, dev)
    db.commit()
    return {"ingested": len(rows), "device": dev.name, "rows_in_file": int(len(df))}


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None

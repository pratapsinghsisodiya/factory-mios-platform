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

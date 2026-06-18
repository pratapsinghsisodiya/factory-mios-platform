"""Asset hierarchy: Location → Plant → Department → Line. Lightweight CRUD."""
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from app.api.deps import DbDep, CurrentUser, tenant_scope, require_roles
from app.models.models import Location, Plant, Department, Line, Device

router = APIRouter(prefix="/hierarchy", tags=["hierarchy"])
_writer = [Depends(require_roles("tenant_admin", "plant_admin", "engineer"))]


class NodeIn(BaseModel):
    name: str
    code: str | None = None
    parent_id: str | None = None
    timezone: str | None = "UTC"


def _list(db, model, tid):
    return [{c.name: getattr(r, c.name) for c in model.__table__.columns}
            for r in db.query(model).filter(model.tenant_id == tid).all()]


@router.get("/tree")
def tree(db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    return {
        "locations": _list(db, Location, tid),
        "plants": _list(db, Plant, tid),
        "departments": _list(db, Department, tid),
        "lines": _list(db, Line, tid),
        "devices": [{"id": d.id, "name": d.name, "machine_type": d.machine_type,
                     "connection_type": d.connection_type, "status": d.status,
                     "config": d.config} for d in db.query(Device).filter(Device.tenant_id == tid).all()],
    }


@router.post("/locations", dependencies=_writer)
def add_location(body: NodeIn, db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    o = Location(tenant_id=tid, name=body.name, code=body.code, timezone=body.timezone or "UTC")
    db.add(o); db.commit(); db.refresh(o)
    return {"id": o.id, "name": o.name}


@router.post("/plants", dependencies=_writer)
def add_plant(body: NodeIn, db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    o = Plant(tenant_id=tid, name=body.name, code=body.code, location_id=body.parent_id)
    db.add(o); db.commit(); db.refresh(o)
    return {"id": o.id, "name": o.name}


@router.post("/departments", dependencies=_writer)
def add_department(body: NodeIn, db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    o = Department(tenant_id=tid, name=body.name, plant_id=body.parent_id)
    db.add(o); db.commit(); db.refresh(o)
    return {"id": o.id, "name": o.name}


@router.post("/lines", dependencies=_writer)
def add_line(body: NodeIn, db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    o = Line(tenant_id=tid, name=body.name, code=body.code, plant_id=body.parent_id)
    db.add(o); db.commit(); db.refresh(o)
    return {"id": o.id, "name": o.name}

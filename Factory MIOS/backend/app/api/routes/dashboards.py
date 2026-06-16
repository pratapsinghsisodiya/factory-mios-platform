from fastapi import APIRouter, Depends, HTTPException, status
from app.api.deps import DbDep, CurrentUser, tenant_scope, require_roles
from app.models.models import Dashboard
from app.schemas.schemas import DashboardIn
from app.services.catalog import catalog, TEMPLATES

router = APIRouter(prefix="/dashboards", tags=["dashboards"])


@router.get("/catalog")
def get_catalog():
    """Public-ish: the widget + industry + template catalog used by the builder."""
    return catalog()


@router.post("", dependencies=[Depends(require_roles("tenant_admin", "engineer"))])
def create_dashboard(body: DashboardIn, db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    layout = body.layout
    if not layout and body.template:
        tpl = next((t for t in TEMPLATES if t["key"] == body.template), None)
        if tpl:
            layout = {"widgets": [{"type": w, "title": w, "x": i % 3, "y": i // 3}
                                  for i, w in enumerate(tpl["widgets"])]}
    dash = Dashboard(tenant_id=tid, name=body.name, template=body.template, layout=layout)
    db.add(dash)
    db.commit()
    db.refresh(dash)
    return {"id": dash.id, "name": dash.name, "layout": dash.layout}


@router.get("")
def list_dashboards(db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    return [{"id": d.id, "name": d.name, "template": d.template, "layout": d.layout}
            for d in db.query(Dashboard).filter(Dashboard.tenant_id == tid).all()]


@router.get("/{dash_id}")
def get_dashboard(dash_id: str, db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    d = db.query(Dashboard).filter(Dashboard.id == dash_id, Dashboard.tenant_id == tid).first()
    if not d:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dashboard not found")
    return {"id": d.id, "name": d.name, "template": d.template, "layout": d.layout}


@router.put("/{dash_id}", dependencies=[Depends(require_roles("tenant_admin", "engineer"))])
def update_dashboard(dash_id: str, body: DashboardIn, db: DbDep, user: CurrentUser):
    """Save a layout authored in the drag-and-drop builder."""
    tid = tenant_scope(user)
    d = db.query(Dashboard).filter(Dashboard.id == dash_id, Dashboard.tenant_id == tid).first()
    if not d:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dashboard not found")
    d.name = body.name or d.name
    if body.template:
        d.template = body.template
    d.layout = body.layout
    db.commit()
    db.refresh(d)
    return {"id": d.id, "name": d.name, "template": d.template, "layout": d.layout}


@router.delete("/{dash_id}", status_code=204,
               dependencies=[Depends(require_roles("tenant_admin", "engineer"))])
def delete_dashboard(dash_id: str, db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    d = db.query(Dashboard).filter(Dashboard.id == dash_id, Dashboard.tenant_id == tid).first()
    if d:
        db.delete(d)
        db.commit()
    return None

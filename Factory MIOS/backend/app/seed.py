"""Create tables, promote telemetry to a hypertable, seed admin + demo tenant
with sample hierarchy, telemetry definitions, and master data. Idempotent —
backfills demo sample data even if the tenant already exists."""
import logging
from sqlalchemy import text
from app.core.database import engine, SessionLocal, Base
from app.core.config import settings
from app.core.security import hash_password
import app.models.models as m

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("seed")


def _ensure_master(db, tid, dataset, key, attrs):
    if not db.query(m.MasterData).filter(m.MasterData.tenant_id == tid,
                                         m.MasterData.dataset == dataset, m.MasterData.key == key).first():
        db.add(m.MasterData(tenant_id=tid, dataset=dataset, key=key, attributes=attrs))


def init():
    Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        try:
            conn.execute(text(
                "SELECT create_hypertable('telemetry', 'ts', if_not_exists => TRUE, migrate_data => TRUE)"))
            log.info("telemetry is a hypertable")
        except Exception as e:  # noqa: BLE001
            log.warning("Skipping hypertable creation: %s", e)
        # Idempotent column adds for telemetry_definitions (no Alembic in this build)
        for col, ddl in [
            ("kpi_type", "ALTER TABLE telemetry_definitions ADD COLUMN IF NOT EXISTS kpi_type VARCHAR(40) DEFAULT 'raw'"),
            ("is_static", "ALTER TABLE telemetry_definitions ADD COLUMN IF NOT EXISTS is_static BOOLEAN DEFAULT FALSE"),
            ("static_value", "ALTER TABLE telemetry_definitions ADD COLUMN IF NOT EXISTS static_value VARCHAR(255)"),
            ("alarm_min", "ALTER TABLE telemetry_definitions ADD COLUMN IF NOT EXISTS alarm_min DOUBLE PRECISION"),
            ("alarm_max", "ALTER TABLE telemetry_definitions ADD COLUMN IF NOT EXISTS alarm_max DOUBLE PRECISION"),
            ("kpi_device", "ALTER TABLE kpi_definitions ADD COLUMN IF NOT EXISTS device_id UUID"),
            ("shift_device", "ALTER TABLE shifts ADD COLUMN IF NOT EXISTS device_id UUID"),
        ]:
            try:
                conn.execute(text(ddl))
            except Exception as e:  # noqa: BLE001
                log.warning("Column migrate %s skipped: %s", col, e)

    db = SessionLocal()
    try:
        if not db.query(m.User).filter(m.User.email == settings.ADMIN_EMAIL.lower()).first():
            db.add(m.User(email=settings.ADMIN_EMAIL.lower(), full_name="Platform Admin",
                          hashed_password=hash_password(settings.ADMIN_PASSWORD), role="platform_admin"))
            db.commit()
            log.info("Created platform admin %s", settings.ADMIN_EMAIL)

        demo = db.query(m.Tenant).filter(m.Tenant.slug == "demo-factory").first()
        if not demo:
            demo = m.Tenant(name="Demo Factory", slug="demo-factory", industry="automotive")
            db.add(demo); db.flush()
            db.add(m.User(tenant_id=demo.id, email="demo@factory-mios.local", full_name="Demo Engineer",
                          hashed_password=hash_password("Demo!2026"), role="tenant_admin"))
            db.commit()
            log.info("Created demo tenant (login demo@factory-mios.local / Demo!2026)")
        tid = demo.id

        # ---- Backfill hierarchy (idempotent) ----
        if not db.query(m.Location).filter(m.Location.tenant_id == tid).first():
            loc = m.Location(tenant_id=tid, name="Pune", code="PUN", timezone="Asia/Kolkata")
            db.add(loc); db.flush()
            plant = m.Plant(tenant_id=tid, location_id=loc.id, name="Plant 1", code="P1")
            db.add(plant); db.flush()
            dept = m.Department(tenant_id=tid, plant_id=plant.id, name="Machining")
            db.add(dept); db.flush()
            db.add(m.Line(tenant_id=tid, plant_id=plant.id, department_id=dept.id, name="Line 1", code="L1"))
            db.commit()
            log.info("Seeded sample hierarchy")

        # ---- Device + telemetry defs ----
        dev = db.query(m.Device).filter(m.Device.tenant_id == tid).first()
        if not dev:
            dev = m.Device(tenant_id=tid, name="CNC-01", machine_type="CNC Mill", connection_type="mqtt",
                           latitude=18.5204, longitude=73.8567, status="provisioned")
            db.add(dev); db.commit()
        if not db.query(m.TelemetryDefinition).filter(m.TelemetryDefinition.tenant_id == tid).first():
            defs = [("good_count", "Good Count", "counter", "Nos", "last", {"oee": True}),
                    ("total_count", "Total Count", "counter", "Nos", "last", {"oee": True}),
                    ("reject_count", "Rejection", "counter", "Nos", "last", {"quality": True}),
                    ("cycle_time", "Cycle Time", "numeric", "Sec", "avg", {"performance": True}),
                    ("energy_kw", "Energy", "numeric", "kW", "avg", {"ems": True}),
                    ("running", "Machine State", "status", "", "last", {"realtime": True})]
            for raw, disp, dt, unit, agg, usage in defs:
                db.add(m.TelemetryDefinition(tenant_id=tid, device_id=dev.id, raw_name=raw,
                       display_name=disp, data_type=dt, unit=unit, aggregation=agg, usage=usage))
            db.commit()
            log.info("Seeded telemetry definitions")

        # ---- Shifts ----
        if not db.query(m.Shift).filter(m.Shift.tenant_id == tid).first():
            db.add(m.Shift(tenant_id=tid, name="A Shift", start_time="06:00", end_time="14:00", target_production=480))
            db.add(m.Shift(tenant_id=tid, name="B Shift", start_time="14:00", end_time="22:00", target_production=480))
            db.commit()

        # ---- Master data (always backfilled if missing) ----
        _ensure_master(db, tid, "products", "P-100",
                       {"name": "Bracket", "target_cycle_time": 30.0, "ideal_run_rate": 120})
        for r in ["Tool change", "No material", "Breakdown", "Setup/Changeover", "Quality issue", "Break"]:
            _ensure_master(db, tid, "downtime_reasons", r,
                           {"category": "planned" if r in ("Setup/Changeover", "Break") else "unplanned"})
        for d in ["Dimension out", "Surface defect", "Burr", "Crack", "Tool mark"]:
            _ensure_master(db, tid, "quality_defects", d, {})
        db.commit()
        log.info("Master data ensured")
    finally:
        db.close()


if __name__ == "__main__":
    init()

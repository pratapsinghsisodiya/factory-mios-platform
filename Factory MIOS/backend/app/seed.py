"""Create tables, promote telemetry to a hypertable, seed the platform admin
and a demo tenant. Idempotent — safe to run on every boot."""
import logging
from sqlalchemy import text
from app.core.database import engine, SessionLocal, Base
from app.core.config import settings
from app.core.security import hash_password
import app.models.models as m

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("seed")


def init():
    Base.metadata.create_all(bind=engine)
    # Promote telemetry to a TimescaleDB hypertable (no-op if already done / no extension)
    with engine.begin() as conn:
        try:
            conn.execute(text(
                "SELECT create_hypertable('telemetry', 'ts', if_not_exists => TRUE, migrate_data => TRUE)"
            ))
            log.info("telemetry is a hypertable")
        except Exception as e:  # noqa: BLE001
            log.warning("Skipping hypertable creation: %s", e)

    db = SessionLocal()
    try:
        admin = db.query(m.User).filter(m.User.email == settings.ADMIN_EMAIL.lower()).first()
        if not admin:
            db.add(m.User(email=settings.ADMIN_EMAIL.lower(), full_name="Platform Admin",
                          hashed_password=hash_password(settings.ADMIN_PASSWORD),
                          role="platform_admin"))
            db.commit()
            log.info("Created platform admin %s", settings.ADMIN_EMAIL)

        demo = db.query(m.Tenant).filter(m.Tenant.slug == "demo-factory").first()
        if not demo:
            demo = m.Tenant(name="Demo Factory", slug="demo-factory", industry="automotive")
            db.add(demo)
            db.flush()
            db.add(m.User(tenant_id=demo.id, email="demo@factory-mios.local",
                          full_name="Demo Engineer", hashed_password=hash_password("Demo!2026"),
                          role="tenant_admin"))
            dev = m.Device(tenant_id=demo.id, name="CNC-01", machine_type="CNC Mill",
                           connection_type="mqtt", latitude=18.5204, longitude=73.8567,
                           status="provisioned")
            db.add(dev)
            db.add(m.Shift(tenant_id=demo.id, name="A Shift", start_time="06:00",
                           end_time="14:00", target_production=480))
            db.add(m.MasterData(tenant_id=demo.id, dataset="parts", key="P-100",
                                attributes={"name": "Bracket", "target_cycle_time": 30.0}))
            db.commit()
            log.info("Seeded demo tenant (login demo@factory-mios.local / Demo!2026)")
    finally:
        db.close()


if __name__ == "__main__":
    init()
